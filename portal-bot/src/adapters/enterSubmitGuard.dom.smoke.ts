// ENTER ON AN APPLICATION FORM CAN FILE IT.
//
// pressEnterInLastFilledField is a fallback for SEARCH pages whose submit is an unnamed icon
// (Miami's property magnifier). On permiteyes.us the walk reached a 176-field single-page
// permit application, the planner found no named advance, the walk fell through to Enter —
// and Enter triggered the form's own submit. The page went to about:blank; on a live
// application that keystroke files it. Automation never submits, so Enter must only ever
// fire where a person would press it: a search box, not an application.
//
//   MUST NOT: press Enter (or record a press step) on a page with many fillable fields.
//   MUST STILL: press Enter on a search-shaped page (few fields) — covered by
//   enterSubmit.dom.smoke; here we assert the application-form REFUSAL.
//
//   npx tsx portal-bot/src/adapters/enterSubmitGuard.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// A single-page application form: many fields, no named Next/Continue, and a real submit
// whose firing navigates away (here: to a page that records it submitted). If the walk
// presses Enter, `submitted` flips — which must never happen.
const PAGE = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <h2>Permit Application</h2>
  <form id="app" onsubmit="document.title='SUBMITTED';document.getElementById('flag').textContent='FILED';return false;">
    <label>Owner Name</label><input name="owner" type="text">
    <label>Address</label><input name="addr" type="text">
    <label>City</label><input name="city" type="text">
    <label>Zip</label><input name="zip" type="text">
    <label>Email</label><input name="email" type="text">
    <label>Phone</label><input name="phone" type="text">
    <label>System Size</label><input name="kw" type="text">
    <input type="submit" value="Submit Application">
  </form>
  <div id="flag">not-filed</div>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

// Planner: fill several fields, name no advance, don't claim review. This is the exact state
// that dropped permiteyes into the Enter fallback.
const planner: LearnPlanner = async (req) => {
  const fills = req.fields
    .map((f, i) => ({ f, i }))
    .filter((x) => x.f.fieldType === "text")
    .slice(0, 7)
    .map((x) => ({ selectorIndex: x.i, value: "X" }));
  return { fills, atReview: false };
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await ctx.newPage();
await page.goto(url);

const adapter = new AutoLearnAdapter("Enter Guard Test", planner, { maxPages: 2 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(adapter as any).page = page;
const result = await adapter.learn(
  { portalUrl: url } as never,
  { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "T" } as never,
);

const filed = (await page.locator("#flag").textContent().catch(() => "")) ?? "";
const pressSteps = result.steps.filter((s) => String(s.action) === "press");
console.log(`   flag=${JSON.stringify(filed)}  press steps=${pressSteps.length}`);

check("Enter is NOT pressed on a many-field application form",
  pressSteps.length === 0,
  `${pressSteps.length} press step(s) recorded — Enter fired on an application form`);
check("the application form was NOT submitted",
  filed !== "FILED",
  "the form's submit fired — automation must never file an application");

await browser.close();
server.close();
console.log(failures === 0 ? "enterSubmitGuard.dom.smoke: PASS" : `enterSubmitGuard.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
