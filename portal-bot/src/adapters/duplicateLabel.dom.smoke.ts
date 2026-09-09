// AMBIGUOUS IS NOT RESOLVED.
//
// PowerClerk renders two identical contact blocks — Installer, then Electrical Contractor —
// and both have a "Name", a "Company", an "Address". The extractor prefers the LABEL as the
// selector and keeps the unique #id as a fallback. The learn's locator() returned the label
// locator because it "resolved" (count > 0 — it matched BOTH blocks), every action on it
// threw a strict-mode violation, applyFill swallowed the throw, and Ameren's second block
// read "required_never_filled: Name, Company, Address" on four consecutive live runs while
// the unique fallback sat unconsulted.
//
//   MUST PASS    — a duplicated label's fill lands, via the unique #id fallback, in the
//                  block the planner chose.
//   MUST EXCLUDE — a unique label keeps resolving by label (no behaviour change), and a
//                  selector with no narrowing fallback keeps the old broad resolution.
//
//   npx tsx portal-bot/src/adapters/duplicateLabel.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Two contact blocks, PowerClerk-shaped: same labels, distinct render-order ids.
const PAGE = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <h3>Installer/Equipment Contractor</h3>
  <label for="pcInputBase10">Name</label><input id="pcInputBase10" type="text">
  <label for="pcInputBase11">Company</label><input id="pcInputBase11" type="text">
  <h3>Electrical Contractor</h3>
  <label for="pcInputBase20">Name</label><input id="pcInputBase20" type="text">
  <label for="pcInputBase21">Company</label><input id="pcInputBase21" type="text">
  <!-- A COLLAPSED block, as Miami's Contact Information renders Owner/Tenant/Qualifier:
       same labels again, unique ids again, and nobody can see it. A fill aimed here burns
       the visibility probe, the reveal attempt and four retries — eighteen of those is the
       sixteen minutes that page cost. -->
  <div id="collapsed" style="display:none">
    <label for="pcInputBase30">Qualifier</label><input id="pcInputBase30" type="text">
  </div>
  <label for="pcInputBase31">Qualifier</label><input id="pcInputBase31" type="text">
  <label for="unique1">Docket Number</label><input id="unique1" type="text">
  <button id="next">Next</button>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

// The planner fills the SECOND block's Name/Company (indices found at runtime) + the unique
// field, then stops.
const planner: LearnPlanner = async (req) => {
  const fills: Array<{ selectorIndex: number; value: string }> = [];
  const nameIdxs = req.fields.map((f, i) => ({ f, i })).filter((x) => x.f.label === "Name").map((x) => x.i);
  const companyIdxs = req.fields.map((f, i) => ({ f, i })).filter((x) => x.f.label === "Company").map((x) => x.i);
  const docket = req.fields.findIndex((f) => f.label === "Docket Number");
  const qual = req.fields.findIndex((f) => f.label === "Qualifier");
  if (qual >= 0) fills.push({ selectorIndex: qual, value: "Q-9" });
  if (nameIdxs.length >= 2) fills.push({ selectorIndex: nameIdxs[1], value: "Charles" });
  if (companyIdxs.length >= 2) fills.push({ selectorIndex: companyIdxs[1], value: "TML INTERNATIONAL LLC" });
  if (docket >= 0) fills.push({ selectorIndex: docket, value: "160001" });
  return { fills, atReview: fills.length === 0 };
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await ctx.newPage();
await page.goto(url);

const adapter = new AutoLearnAdapter("Dup Label Test", planner, { maxPages: 2 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(adapter as any).page = page;
const result = await adapter.learn(
  { portalUrl: url } as never,
  { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "T" } as never,
);

const block2Name = await page.locator("#pcInputBase20").inputValue().catch(() => "");
const block2Company = await page.locator("#pcInputBase21").inputValue().catch(() => "");
const block1Name = await page.locator("#pcInputBase10").inputValue().catch(() => "");
const docketVal = await page.locator("#unique1").inputValue().catch(() => "");
console.log(`   block2: name=${JSON.stringify(block2Name)} company=${JSON.stringify(block2Company)}; block1 name=${JSON.stringify(block1Name)}; docket=${JSON.stringify(docketVal)}`);

check("a duplicated label's fill lands via its unique #id fallback",
  block2Name === "Charles" && block2Company === "TML INTERNATIONAL LLC",
  `block2 name=${JSON.stringify(block2Name)} company=${JSON.stringify(block2Company)} — the ambiguous label locator strict-throws and the fill silently never happens`);
check("...in the block the PLANNER chose, not the first one in the DOM",
  block1Name === "",
  `block1 name=${JSON.stringify(block1Name)} — landing there files the wrong party's details`);
const qualVisible = await page.locator("#pcInputBase31").inputValue().catch(() => "");
const qualHidden = await page.locator("#pcInputBase30").inputValue().catch(() => "");
check("a duplicated label prefers the VISIBLE control, not a unique hidden twin",
  qualVisible === "Q-9" && qualHidden === "",
  `visible=${JSON.stringify(qualVisible)} hidden=${JSON.stringify(qualHidden)} — a fill aimed at a collapsed block burns the probe, the reveal and four retries`);
check("a unique label still resolves normally",
  docketVal === "160001",
  `docket=${JSON.stringify(docketVal)}`);
check("the fills are recorded as steps",
  result.steps.filter((s) => s.action === "fill").length >= 3,
  `recorded ${result.steps.filter((s) => s.action === "fill").length} fill step(s)`);

await browser.close();
server.close();
console.log(failures === 0 ? "duplicateLabel.dom.smoke: PASS" : `duplicateLabel.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
