// THE LAST PAGE NEVER GOT THE FIX EVERY OTHER PAGE GOT.
//
// A portal that re-renders a section blanks the values already in it. The engine handles
// that: before each advancing click it re-runs the recorded step for anything the portal now
// reports empty. But the re-assert is attached to the ADVANCE, so the one page it never
// reaches is the last one -- the page the run stops on and hands to a human.
//
// Live on Ameren Illinois: Name, Company, Address, Email and Phone were each filled, blanked
// by a re-render, re-asserted on the way out of earlier pages, and then left blank on the
// final page because no advance ever followed them. Five required fields, on the one page a
// person is asked to check.
//
// The page below is that behaviour reduced to its cause: filling the second field re-renders
// the first and drops what was in it.
//   npx tsx portal-bot/src/adapters/finalPageReassert.dom.smoke.ts
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
  <h3>Contact</h3>
  <label for="nm">Name *</label><input id="nm" />
  <label for="ph">Phone *</label><input id="ph" />
  <script>
    // The portal quirk, exactly: touching the later field re-renders the earlier one and
    // the value goes with it. Once only, so a re-assert can succeed.
    var dropped = false;
    document.getElementById("ph").addEventListener("change", function () {
      if (dropped) return;
      dropped = true;
      document.getElementById("nm").value = "";
    });
  </script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

// No advancing click anywhere: the run ENDS on this page, which is the whole point.
const recipe = {
  id: "fp1", scopeType: "utility", profileKey: "il|unknown|ameren illinois", state: "IL",
  ahj: "", utility: "Ameren Illinois", portalPlatform: "powerclerk", portalUrl: url,
  status: "complete", version: 1,
  steps: [
    { action: "fill", phase: "fill", field: "", note: "Name", value: "ZZTest Replay Benchmark", selector: { css: "#nm" } },
    { action: "fill", phase: "fill", field: "", note: "Phone", value: "5035550142", selector: { css: "#ph" } },
  ] as unknown as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(url);
const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
(adapter as unknown as { page: unknown }).page = page;
// Count gap-fill offers without a live planner. Re-asserting can only restore a value the
// recipe already knows how to write; a required field the recipe has NO step for is what
// gap-fill is for, and on Ameren those were five of them on the final page.
let gapFillCalls = 0;
(adapter as unknown as { runGapFill: (p: unknown) => Promise<void> }).runGapFill = async () => { gapFillCalls += 1; };
const res = await adapter.fillApplication({} as never);
const data = (res as unknown as { data?: { requiredStillEmpty?: string[]; agingNotes?: string[] } }).data ?? {};
const name = await page.locator("#nm").inputValue().catch(() => "");
const phone = await page.locator("#ph").inputValue().catch(() => "");
console.log(`   final page -> Name=${JSON.stringify(name)} Phone=${JSON.stringify(phone)}`);
console.log(`              -> requiredStillEmpty ${JSON.stringify(data.requiredStillEmpty ?? [])}`);

check("THE LIVE BLANK: a value the last page dropped is put back",
  name === "ZZTest Replay Benchmark",
  `Name is ${JSON.stringify(name)} — the run ended handing a person a blank required field`);

check("...and the other value is not disturbed putting it back",
  phone === "5035550142", `Phone is ${JSON.stringify(phone)}`);

check("...so the run does not report it as still empty",
  !(data.requiredStillEmpty ?? []).some((b) => /name/i.test(b)), JSON.stringify(data.requiredStillEmpty));

check("...and it SAYS it re-asserted, because a value that needs re-asserting is a quirk worth knowing",
  (data.agingNotes ?? []).some((w) => /re-asserted/i.test(w)), JSON.stringify(data.agingNotes));

check("...and GAP-FILL is offered the last page too, for fields the recipe never recorded",
  gapFillCalls === 1,
  `gap-fill ran ${gapFillCalls} time(s) on a run that ended on a page it had never filled`);

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} final-page re-assert check(s) FAILED.`); process.exit(1); }
console.log("\nAll final-page re-assert checks passed (real Chromium).");
process.exit(0);
