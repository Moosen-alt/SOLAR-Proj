// THE NEXT BUTTON THE PLANNER DID NOT NAME.
//
// Twelve portals in the 59-portal learn benchmark recorded fills and never reached review.
// Their stored traces all end the same way: a filled page, and `adv=-`. The walk stops on a
// page it has just completed while that page still shows dozens of buttons -- ComEd ended on
// a form with 27 of them, Boston on one with 96. Whatever the planner was doing, "no
// advance" was not true of the page.
//
// The fallback is deliberately NARROWER than the planner is allowed to be, and the second
// half of this file is why: clicking the wrong button here files somebody's application.
//
// This smoke used to redeclare ADVANCE_ONLY and SUBMIT_INTENT ("kept in step with
// autoLearnAdapter") and test a local wouldClick() — it launched no browser and passed with the
// bot code deleted, and the copy had already drifted (the real finder also refuses pagination
// and pay controls). It now runs AutoLearnAdapter.clickFallbackAdvance itself, in Chromium,
// one button per page, and records what was ACTUALLY clicked.
//   npx tsx portal-bot/src/adapters/fallbackAdvance.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import type { RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// One filled form and ONE button carrying the label under test. A click is recorded in
// window.__clicks and moves the page, so the finder's "did it move" check can pass.
const pageFor = (label: string): string => `<!doctype html><html><body>
  <form onsubmit="return false">
    <label for="n">Project Name</label><input id="n" value="Fixture">
    <button type="button" onclick="(window.__clicks = window.__clicks || []).push(this.textContent); document.body.innerHTML = '<h1>moved on</h1>';">${label
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")}</button>
  </form>
</body></html>`;

const server = http.createServer((q, r) => {
  const label = new URL(String(q.url ?? "/"), "http://x").searchParams.get("label") ?? "";
  r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  r.end(pageFor(label));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const planner: LearnPlanner = async () => ({ fills: [], atReview: false });

/** Run the REAL finder on a page offering exactly one button. */
const attempt = async (label: string): Promise<{ returned: boolean; clicked: string[]; recorded: number }> => {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/?label=${encodeURIComponent(label)}`);
  const adapter = new AutoLearnAdapter("Fallback Advance Fixture", planner, { maxPages: 1 });
  (adapter as unknown as { page: unknown }).page = page;
  // The page took a value — the finder refuses to advance past a page it filled nothing on.
  const steps: RecipeStep[] = [{ action: "fill", phase: "fill", selector: { css: "#n" }, value: "Fixture" }];
  const fields = [
    { label: "Project Name", fieldType: "text", selector: { css: "#n" } },
    { label, fieldType: "button", selector: { role: "button", name: label, exact: true } },
  ];
  const returned = await (adapter as unknown as { clickFallbackAdvance(s: RecipeStep[], f: unknown[]): Promise<boolean> })
    .clickFallbackAdvance(steps, fields).catch(() => false);
  const clicked = await page.evaluate(() => ((window as unknown as { __clicks?: string[] }).__clicks ?? [])).catch(() => [] as string[]);
  await page.close();
  return { returned, clicked, recorded: steps.length - 1 };
};

// ---- what it MUST take ---------------------------------------------------------
for (const label of ["Next", "Continue", "Next Step", "Save and Continue", "Save & Next", "Proceed"]) {
  const r = await attempt(label);
  check(`takes a plain advance: ${JSON.stringify(label)}`, r.returned && r.clicked.length === 1 && r.recorded === 1, JSON.stringify(r));
}

// ---- what it MUST NOT take -----------------------------------------------------
// Accela's page advance is literally "Continue Application" -- and on the LAST page that
// same button FILES the permit. Losing a legitimate advance costs a page we do not learn;
// clicking a submit costs a filing nobody authorised. Only one of those is recoverable.
const MUST_NOT = [
  "Continue Application »",
  "Submit", "Submit Application", "Finish", "Finalize", "Confirm Submission", "File Application", "Place Order",
  // pay-shaped advances: ADVANCE_ONLY-anchored, so only the pay refusal stops them
  "Continue and Pay", "Continue to Payment", "Next - Pay Fees",
  // a table pager is not a wizard's way forward
  "Next page", "Next 10",
  // not an advance at all
  "Pay Fees Due", "Add to Cart", "Checkout", "Cancel", "Back", "Search",
  "Please review the details before you continue to the next screen",
];
for (const label of MUST_NOT) {
  const r = await attempt(label);
  check(`REFUSES ${JSON.stringify(label)} — nothing clicked, nothing recorded`, !r.returned && r.clicked.length === 0 && r.recorded === 0, JSON.stringify(r));
}

// A page we filled nothing on is not ours to advance past.
{
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/?label=Next`);
  const adapter = new AutoLearnAdapter("Fallback Advance Fixture", planner, { maxPages: 1 });
  (adapter as unknown as { page: unknown }).page = page;
  const returned = await (adapter as unknown as { clickFallbackAdvance(s: RecipeStep[], f: unknown[]): Promise<boolean> })
    .clickFallbackAdvance([], [{ label: "Next", fieldType: "button", selector: { role: "button", name: "Next", exact: true } }]);
  const clicked = await page.evaluate(() => ((window as unknown as { __clicks?: string[] }).__clicks ?? []));
  check("a page that took no value is never advanced past", !returned && clicked.length === 0, JSON.stringify({ returned, clicked }));
  await page.close();
}

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} fallback-advance check(s) FAILED.`); process.exit(1); }
console.log("\nAll fallback-advance checks passed (real Chromium, real clickFallbackAdvance).");
process.exit(0);
