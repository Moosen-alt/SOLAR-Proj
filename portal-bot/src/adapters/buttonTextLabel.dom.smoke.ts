// A BUTTON'S VISIBLE TEXT BEATS ITS name ATTRIBUTE.
//
// permiteyes.us renders its footer as <button id="submit_form" name="submit_form">Submit</button>
// plus "Save and Exit" and "Exit", all with name attributes. labelFor returned `name` first, so
// they were labelled "submit_form" / "save_form1" / "exit_form", and SUBMIT_INTENT.test(
// "submit_form") is FALSE - \bsubmit\b finds no word boundary before an underscore. A 176-field
// single-page application whose only forward control was a Submit button looked like it had none.
//
// The natural experiment that proved it lives INSIDE THE SAME LIVE PAGE: the one copy with an id
// but NO name was labelled "Exit" correctly, because it fell through to textContent.
//
// It costs more than submit detection. A "Next" named next_page was labelled "next_page", so
// clickFallbackAdvance could not see the page's way forward and the walk stopped where a person
// would simply have clicked Next.
//
//   MUST PASS    - a named button is labelled by what a human reads on it, and a named "Next" is
//                  still usable as an advance.
//   MUST EXCLUDE - a name-less button keeps its old label; a <select> is never labelled with its
//                  option soup; a text input still prefers its real label over its name.
//
//   npx tsx portal-bot/src/adapters/buttonTextLabel.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGE = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <h2>Application</h2>
  <label for="owner">Owner Name</label><input id="owner" name="txtOwnerName" type="text">
  <label for="util">Utility</label>
  <select id="util" name="ddlUtility"><option>Ameren Illinois</option><option>ComEd</option></select>
  <!-- permiteyes' exact shape: name present, real text inside -->
  <button type="button" id="submit_form" name="submit_form">Submit</button>
  <button type="button" name="save_form1">Save and Exit</button>
  <!-- the in-page control: an id but NO name, which always labelled correctly -->
  <button type="button" id="exit_form1">Exit</button>
  <!-- the advance whose name blinded clickFallbackAdvance -->
  <button type="button" id="next" name="next_page" onclick="document.getElementById('p2').style.display='block';this.style.display='none'">Next</button>
  <div id="p2" style="display:none"><label for="acct">Account</label><input id="acct" name="txtAcct" type="text"></div>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const seen: string[] = [];
const planner: LearnPlanner = async (req) => {
  for (const f of req.fields) seen.push(String(f.label ?? ""));
  const owner = req.fields.findIndex((f) => String(f.label ?? "") === "Owner Name");
  return { fills: owner >= 0 ? [{ selectorIndex: owner, value: "T" }] : [], atReview: false };
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await ctx.newPage();
await page.goto(url);

const adapter = new AutoLearnAdapter("Button Label Test", planner, { maxPages: 2 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(adapter as any).page = page;
await adapter.learn(
  { portalUrl: url } as never,
  { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "T" } as never,
);

console.log(`   labels seen: ${JSON.stringify(Array.from(new Set(seen)))}`);
const has = (s: string): boolean => seen.includes(s);

check("a named button is labelled by its visible text, not its name attribute",
  has("Submit") && !has("submit_form"),
  `expected "Submit", got ${JSON.stringify(seen.filter((s) => /submit/i.test(s)))} — SUBMIT_INTENT cannot match across an underscore, so the page's only forward control is invisible`);

check("...and so is a multi-word one",
  has("Save and Exit") && !has("save_form1"),
  `got ${JSON.stringify(seen.filter((s) => /save/i.test(s)))}`);

check("a named advance is labelled 'Next', so the walk can still use it",
  has("Next") && !has("next_page"),
  `got ${JSON.stringify(seen.filter((s) => /next/i.test(s)))} — a "Next" read as "next_page" is a page the walk never gets past`);

check("MUST EXCLUDE: a name-less button is unchanged",
  has("Exit"),
  `the id-only control lost its label: ${JSON.stringify(seen)}`);

check("MUST EXCLUDE: a <select> is not labelled with its option soup",
  !seen.some((s) => /Ameren Illinois\s*ComEd|ComEd\s*Ameren/i.test(s)),
  `a select took its textContent as a label: ${JSON.stringify(seen.filter((s) => /Ameren|ComEd/.test(s)))}`);

check("MUST EXCLUDE: a text input still prefers its real label over its name",
  has("Owner Name") && !has("txtOwnerName"),
  `got ${JSON.stringify(seen.filter((s) => /owner/i.test(s)))}`);

await browser.close();
server.close();
console.log(failures === 0 ? "buttonTextLabel.dom.smoke: PASS" : `buttonTextLabel.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
