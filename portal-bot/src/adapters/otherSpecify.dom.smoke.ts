// A REQUIRED "OTHER — PLEASE SPECIFY" BOX IS ANSWERED; NOTHING ELSE IS.
//
// Coos Bay's Category of Construction offers "Other", which reveals a REQUIRED
// "Other Category of Construction" text box. The planner never saw it (it appeared after its
// fills), the learn walked on, and the portal refused the page. fillOtherSpecifyFields answers
// exactly that shape — and nothing that merely looks like it.
//
// This smoke used to test its OWN copy of the page-side scan ("mirroring fillOtherSpecifyFields"),
// so it passed with the bot code deleted. It now runs AutoLearnAdapter.fillOtherSpecifyFields
// itself against the fixture and reads back what landed.
//   npx tsx portal-bot/src/adapters/otherSpecify.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import type { RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const PAGE = `<!doctype html><html><body>
  <!-- Coos Bay's shape: parent select on "Other", revealing a REQUIRED specify box. -->
  <div>
    <label for="cat">Category of Construction:</label>
    <select id="cat"><option selected>Other</option></select>
  </div>
  <div>
    <label for="oth">* Other Category of Construction:</label>
    <input type="text" id="oth">
  </div>

  <!-- OPTIONAL free text that DOES match the specify wording. Inventing an answer here puts
       words in the applicant's mouth: only a REQUIRED box is ours to answer. -->
  <div>
    <label for="notes">Other Description (optional)</label>
    <input type="text" id="notes">
  </div>

  <!-- Already answered by a human — must never be overwritten. -->
  <div>
    <label for="done">* Other Type of Work:</label>
    <input type="text" id="done" value="Re-roof">
  </div>

  <!-- The hidden twin ASP.NET leaves in the DOM for the un-chosen branch. -->
  <div style="display:none">
    <label for="hid">* Other Category of Construction:</label>
    <input type="text" id="hid">
  </div>

  <!-- A required field that is simply not a specify box. -->
  <div>
    <label for="valuation">* Job Valuation:</label>
    <input type="text" id="valuation">
  </div>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

const planner: LearnPlanner = async () => ({ fills: [], atReview: true });
const adapter = new AutoLearnAdapter("Other Specify Fixture", planner, { maxPages: 1 });
(adapter as unknown as { page: unknown }).page = page;
const steps: RecipeStep[] = [];
const alreadyFilled: string[] = [];
const filled = await (adapter as unknown as { fillOtherSpecifyFields(s: RecipeStep[], a: string[]): Promise<number> })
  .fillOtherSpecifyFields(steps, alreadyFilled);

const values = await page.evaluate(() => ({
  oth: (document.getElementById("oth") as HTMLInputElement).value,
  notes: (document.getElementById("notes") as HTMLInputElement).value,
  done: (document.getElementById("done") as HTMLInputElement).value,
  hid: (document.getElementById("hid") as HTMLInputElement).value,
  valuation: (document.getElementById("valuation") as HTMLInputElement).value,
}));
console.log(`  filled ${filled}; steps ${JSON.stringify(steps.map((s) => s.note))}`);

check("exactly one box is answered — the required, visible, empty Other-Category box",
  filled === 1 && values.oth.length > 0, `filled=${filled} values=${JSON.stringify(values)}`);
check("an OPTIONAL box that matches the specify wording is left alone", values.notes === "", JSON.stringify(values));
check("a box a human already answered is never overwritten", values.done === "Re-roof", JSON.stringify(values));
check("the hidden ASP.NET twin is not filled", values.hid === "", JSON.stringify(values));
check("an unrelated required field is not treated as a specify box", values.valuation === "", JSON.stringify(values));
check("the step is recorded against the tagged box, with the value that landed",
  steps.length === 1 && steps[0].action === "fill" && steps[0].value === values.oth && /Other Category of Construction/.test(String(steps[0].note)),
  JSON.stringify(steps));
check("...and the label is marked filled so the walk does not answer it twice",
  alreadyFilled.some((l) => /Other Category of Construction/.test(l)), JSON.stringify(alreadyFilled));

// Run again: the box is now answered, so the pass must do nothing.
const again = await (adapter as unknown as { fillOtherSpecifyFields(s: RecipeStep[], a: string[]): Promise<number> })
  .fillOtherSpecifyFields([], []);
check("a second pass over an answered page does nothing", again === 0, `filled ${again}`);

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} other-specify check(s) FAILED.`); process.exit(1); }
console.log("\nAll other-specify checks passed (real Chromium, real fillOtherSpecifyFields).");
process.exit(0);
