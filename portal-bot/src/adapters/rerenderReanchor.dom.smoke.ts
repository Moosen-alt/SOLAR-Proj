// A RE-RENDER THAT CHANGES THE PAGE INVALIDATES AN INDEX, NOT THE PLAN.
//
// PowerClerk opens each contact block with "Existing contact to use for this contact". The walk
// answers it "New Contact" — and that ANSWER EXPANDS THE BLOCK: the Name, Company and Address
// inputs only exist afterwards. So the field list legitimately changes shape, the same-shape
// selector refresh declines, and the old code logged "rerender_changed_the_page" and carried on
// with the pre-render list. Every planned index then pointed at a different control or at
// nothing. Live cost on Ameren, on every cross-project run: "Name [Interconnection Application]"
// and "Company [Interconnection Application]" reported blank on a filing that cannot be
// submitted without them.
//
//   MUST PASS    — after a shape-changing re-render the planner's chosen fields are re-anchored
//                  by label+section and the values land in the controls the planner meant.
//   MUST EXCLUDE — a field whose label became AMBIGUOUS after the re-render is dropped, not
//                  guessed: filling the wrong control is worse than leaving one blank.
//
//   npx tsx portal-bot/src/adapters/rerenderReanchor.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// The PowerClerk shape: a contact-source select that, on "New Contact", REPLACES the block with
// a wider one whose inputs carry fresh render-order ids. The decoy "Name" in a second section is
// what makes label-alone insufficient — the re-anchor must use the SECTION too.
const PAGE = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <h3>Interconnection Application</h3>
  <div id="block">
    <label for="src">Existing contact to use for this contact</label>
    <select id="src" name="src">
      <option value="">Select...</option>
      <option value="new">New Contact</option>
      <option value="c1">Charles Bitton</option>
    </select>
    <label for="pre1">Docket Number</label><input id="pre1" type="text">
  </div>
  <h3>Site Details</h3>
  <label for="sitename">Name</label><input id="sitename" type="text">
  <button id="next">Next</button>
<script>
  // Answering the picker EXPANDS the block — the fields the customer must fill appear only now,
  // and every id in the block is re-minted (PowerClerk's pcInputBase render-order ids).
  document.getElementById('src').addEventListener('change', function () {
    if (this.value !== 'new') return;
    document.getElementById('block').innerHTML =
      '<label for="r9">Existing contact to use for this contact</label>' +
      '<select id="r9"><option value="new" selected>New Contact</option></select>' +
      '<label for="r10">Name</label><input id="r10" type="text">' +
      '<label for="r11">Company</label><input id="r11" type="text">' +
      '<label for="r12">Docket Number</label><input id="r12" type="text">';
  });
</script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

// The planner sees the PRE-render page and asks for the two fields that exist then. After the
// picker is answered the block is wider and every index has moved.
const planner: LearnPlanner = async (req) => {
  const fills: Array<{ selectorIndex: number; value: string }> = [];
  const docket = req.fields.findIndex((f) => String(f.label ?? "") === "Docket Number");
  const siteName = req.fields.findIndex((f) => String(f.label ?? "") === "Name");
  if (docket >= 0) fills.push({ selectorIndex: docket, value: "160001" });
  if (siteName >= 0) fills.push({ selectorIndex: siteName, value: "ZZ Site" });
  return { fills, atReview: fills.length === 0 };
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await ctx.newPage();
await page.goto(url);

const adapter = new AutoLearnAdapter("Rerender Test", planner, { maxPages: 2 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(adapter as any).page = page;
await adapter.learn(
  { portalUrl: url } as never,
  { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "T" } as never,
);

const val = async (sel: string): Promise<string> => (await page.locator(sel).inputValue().catch(() => "")) ?? "";
const docketAfter = await val("#r12");
const nameAfter = await val("#r10");
const companyAfter = await val("#r11");
const siteAfter = await val("#sitename");
console.log(`   post-rerender: docket=${JSON.stringify(docketAfter)} blockName=${JSON.stringify(nameAfter)} company=${JSON.stringify(companyAfter)} siteName=${JSON.stringify(siteAfter)}`);

check("the picker was answered, so the block actually re-rendered",
  (await page.locator("#r12").count()) > 0,
  "the fixture never re-rendered — this test is not exercising the path it claims to");

check("MUST PASS: a planned fill lands in the RE-RENDERED control, not the stale index",
  docketAfter === "160001",
  `Docket Number is ${JSON.stringify(docketAfter)} — the pre-render index pointed at a control that no longer exists, which is how Ameren's Name and Company came back blank`);

check("MUST EXCLUDE: an AMBIGUOUS label is dropped, never guessed",
  // "Name" exists twice after the re-render (the block's and Site Details'), and the planner
  // chose the Site Details one. Section disambiguates it; if it could not, the safe answer is
  // to leave it blank rather than fill the contact block with a site name.
  nameAfter === "" || siteAfter === "ZZ Site",
  `block Name=${JSON.stringify(nameAfter)} siteName=${JSON.stringify(siteAfter)} — a value landed in the wrong "Name"`);

check("MUST NOT: the re-anchor never invents a value for a field nobody planned",
  companyAfter === "",
  `Company=${JSON.stringify(companyAfter)} — nothing planned a Company fill, so nothing may type one`);

await browser.close();
server.close();
console.log(failures === 0 ? "rerenderReanchor.dom.smoke: PASS" : `rerenderReanchor.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
