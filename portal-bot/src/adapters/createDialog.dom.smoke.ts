// A CREATE DIALOG'S "SUBMIT" IS NOT A FILING — AND EVERYTHING ELSE'S STILL IS.
//
// ComEd's ConnectTheGrid gates every application behind a "New Application" drawer whose only
// forward control is labelled "Submit". Rule 1 (automation never files) means the planner will
// never nominate a submit-shaped control, so the learn filled that drawer and stopped with no
// advance — which is why ComEd's list read "No applications were found" after every run.
//
// The exception that unblocks it is a conjunction, because getting it wrong files an
// application with a utility. This pins the one case that must pass and the four that must
// keep failing.
//
// This smoke used to carry its own copy of the page-side detection ("kept in step with
// clickCreateDialogAdvance"), so it passed with the bot code deleted. It now runs
// AutoLearnAdapter.clickCreateDialogAdvance itself and records what was ACTUALLY clicked.
//   npx tsx portal-bot/src/adapters/createDialog.dom.smoke.ts
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

// Every button records its click; the create drawer's Submit also creates the record (the page
// moves), so the finder's "did it do anything" check can pass on the one case that should.
const REC = `onclick="(window.__clicks = window.__clicks || []).push(this.textContent.trim())"`;
const CREATE = `onclick="(window.__clicks = window.__clicks || []).push('Submit'); document.body.innerHTML = '<h1>Application created</h1><label>Project Name <input></label>';"`;
const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

const pages: Record<string, string> = {
  // 1) ComEd's shape AFTER the type choice: the drawer carries the mini-form and a Submit.
  "/create": html(`
    <div role="dialog" style="width:400px;height:300px">
      <h2>New Application</h2>
      <button ${REC}>Distributed Generation</button>
      <label>Project Name <input type="text" value="Fixture Residence"></label>
      <button ${REC}>Cancel</button>
      <button ${CREATE}>Submit</button>
    </div>`),
  // 2) The SAME drawer with a certification gate — that is a filing, and must stay blocked.
  "/certify": html(`
    <div role="dialog" style="width:400px;height:300px">
      <h2>New Application</h2>
      <label><input type="checkbox"> I certify under penalty of perjury that the above is true</label>
      <button ${REC}>Cancel</button>
      <button ${REC}>Submit</button>
    </div>`),
  // 3) A wizard's real final submit, on the PAGE and not in any overlay.
  "/review": html(`
    <h2>Review and Submit</h2>
    <p>By submitting this application you agree it cannot be edited.</p>
    <button ${REC}>Submit</button>`),
  // 4) A create dialog whose forward control is a PAYMENT. Never, under any condition.
  "/pay": html(`
    <div role="dialog" style="width:400px;height:300px">
      <h2>Start New Application</h2>
      <button ${REC}>Cancel</button>
      <button ${REC}>Pay Fee</button>
    </div>`),
  // 5) A dialog that is not about creating anything — an unrelated confirm.
  "/other": html(`
    <div role="dialog" style="width:400px;height:300px">
      <h2>Session about to expire</h2>
      <button ${REC}>Submit</button>
    </div>`),
};

const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(pages[q.url || "/create"] ?? "<html></html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const planner: LearnPlanner = async () => ({ fills: [], atReview: false });

/** Run the REAL create-dialog advance on one fixture page. */
const at = async (route: string, entryOriginated = true): Promise<{ returned: boolean; clicked: string[]; steps: RecipeStep[] }> => {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}${route}`);
  const adapter = new AutoLearnAdapter("Create Dialog Fixture", planner, { maxPages: 1 });
  (adapter as unknown as { page: unknown }).page = page;
  // The exception applies only to a drawer an ENTRY control opened ("New Application").
  if (entryOriginated) (adapter as unknown as { entryLabelsClicked: Set<string> }).entryLabelsClicked.add("New Application");
  const steps: RecipeStep[] = [];
  const returned = await (adapter as unknown as { clickCreateDialogAdvance(s: RecipeStep[]): Promise<boolean> })
    .clickCreateDialogAdvance(steps).catch(() => false);
  const clicked = await page.evaluate(() => ((window as unknown as { __clicks?: string[] }).__clicks ?? [])).catch(() => [] as string[]);
  await page.close();
  return { returned, clicked, steps };
};

const created = await at("/create");
check("a create drawer's Submit is clicked as an advance, and recorded as creating (not filing)",
  created.returned && created.clicked.join("|") === "Submit" && created.steps.length === 1 && /does NOT file/.test(String(created.steps[0].note)),
  JSON.stringify(created));

const notEntry = await at("/create", false);
check("...but only when an ENTRY control opened it — otherwise nothing is clicked",
  !notEntry.returned && notEntry.clicked.length === 0, JSON.stringify(notEntry));

const certifying = await at("/certify");
check("a drawer carrying a certification gate is REFUSED (that is a filing) — nothing clicked",
  !certifying.returned && certifying.clicked.length === 0, JSON.stringify(certifying));

const review = await at("/review");
check("a review page's Submit is untouched — it is not in a dialog at all",
  !review.returned && review.clicked.length === 0, JSON.stringify(review));

const pay = await at("/pay");
check("a create dialog offering only a payment is never clicked",
  !pay.returned && pay.clicked.length === 0, JSON.stringify(pay));

const other = await at("/other");
check("a dialog that is not about creating an application is ignored",
  !other.returned && other.clicked.length === 0, JSON.stringify(other));

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} create-dialog check(s) FAILED.`); process.exit(1); }
console.log("\nAll create-dialog checks passed (real Chromium, real clickCreateDialogAdvance).");
process.exit(0);
