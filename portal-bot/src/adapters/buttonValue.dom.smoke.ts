// A SUBMIT INPUT'S TEXT IS ITS VALUE ATTRIBUTE, AND NOTHING WAS READING IT.
//
// Miami's way forward is <input type="submit" name="btnSubmit" value="Start New
// Application">. An <input> has no textContent, so the extractor's fallbacks reached `name`
// and handed the planner a control called "btnSubmit". Offered that, it went BACK to the
// Legal Agreement page — twice, in two live runs, with the button it needed on screen.
//
// Classic ASP.NET renders every button this way, so this is most of the fleet, and it cuts
// both ways: a real "Submit Application" button whose label read "btnSubmit" matched no
// SUBMIT_INTENT and could be clicked as an ordinary advance — a filing nobody authorised.
//
//   npx tsx portal-bot/src/adapters/buttonValue.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { EXTRACT_SEL, extractFieldsInPage } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGE = `<!doctype html><html><body style="font:14px sans-serif">
  <!-- Miami's shape: the meaning is in value=, the name is machinery. -->
  <input type="submit" name="btnSubmit" id="btnSubmit" value="Start New Application">
  <input type="submit" name="btnFile" value="Submit Application">
  <input type="button" name="btnBack" value="Back to Search">
  <input type="reset" name="btnReset" value="Clear Form">

  <!-- An explicit label still outranks the value: someone wrote it on purpose. -->
  <input type="submit" name="btnAria" value="OK" aria-label="Save and continue to fees">

  <!-- MUST NOT be treated as button text: a TEXT input's value is the user's data, and on a
       replay of a portal that pre-fills, it is the previous applicant's. -->
  <input type="text" name="cbAutoComplete" value="3500 PAN AMERICAN DR">
  <input type="hidden" name="__RequestVerificationToken" value="should-never-be-a-label">

  <!-- No value at all: fall back to what there was before, not to "". -->
  <input type="submit" name="btnSearch" id="btnSearch" value="">
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

const raws = await page.$$eval(EXTRACT_SEL, extractFieldsInPage);
const byName = new Map(raws.map((f) => [f.name ?? "", f]));
console.log(`   labels: ${JSON.stringify(raws.map((f) => `${f.name}=${f.label}`))}`);

check("a submit input is labelled by its VALUE, not its name",
  byName.get("btnSubmit")?.label === "Start New Application",
  `got ${JSON.stringify(byName.get("btnSubmit")?.label)}`);
check("...so does input[type=button]",
  byName.get("btnBack")?.label === "Back to Search",
  `got ${JSON.stringify(byName.get("btnBack")?.label)}`);
check("...and input[type=reset]",
  byName.get("btnReset")?.label === "Clear Form",
  `got ${JSON.stringify(byName.get("btnReset")?.label)}`);
check("a real Submit Application button is now VISIBLY that, so the submit guards can see it",
  /submit application/i.test(String(byName.get("btnFile")?.label ?? "")),
  `got ${JSON.stringify(byName.get("btnFile")?.label)} — labelled "btnFile" it matched no SUBMIT_INTENT and could be clicked as an advance`);
check("an explicit aria-label still wins — someone wrote it on purpose",
  byName.get("btnAria")?.label === "Save and continue to fees",
  `got ${JSON.stringify(byName.get("btnAria")?.label)}`);

// MUST EXCLUDE — the reason this is scoped to button-shaped inputs.
check("a TEXT input's value is NOT its label",
  byName.get("cbAutoComplete")?.label !== "3500 PAN AMERICAN DR",
  `got ${JSON.stringify(byName.get("cbAutoComplete")?.label)} — that is the applicant's data, and on a pre-filled portal it is somebody else's`);
check("a hidden input's value is NOT its label",
  byName.get("__RequestVerificationToken")?.label !== "should-never-be-a-label",
  `got ${JSON.stringify(byName.get("__RequestVerificationToken")?.label)}`);
check("a submit with an EMPTY value keeps the old fallback rather than losing its identity",
  byName.get("btnSearch")?.label === "btnSearch",
  `got ${JSON.stringify(byName.get("btnSearch")?.label)}`);

await browser.close();
server.close();
console.log(failures === 0 ? "buttonValue.dom.smoke: PASS" : `buttonValue.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
