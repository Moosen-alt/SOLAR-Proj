// A RADIO'S ANSWER IS THE WORD NEXT TO IT, AND ITS <label for> MAY POINT AT NOTHING.
//
// Miami's Additional Options page renders each Yes/No question as two radios that share ONE
// id and one name:
//
//   <span>Is this request for a capital construction project for the City of Miami? (Yes / No)</span>
//   <label for="Yes">Yes</label><input id="bolIsCityProject" name="bolIsCityProject" type="radio">
//   <label for="No">No</label>  <input id="bolIsCityProject" name="bolIsCityProject" type="radio">
//
// Those `for` attributes name ids that do not exist anywhere on the page. So every label
// rule misses, `name` wins, and the planner is offered two identical controls both called
// "bolIsCityProject" — three such pairs on one page, six controls, nine words of meaning
// between them and none of it reaching the planner. The portal's answer:
// "You must select one option for City Project Question."
//
// Two things have to be true. The CHOICE is the adjacent word, and the QUESTION is the
// section — because three Yes/No pairs on one page are only distinguishable by what each is
// asking.
//
//   npx tsx portal-bot/src/adapters/choiceLabel.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { EXTRACT_SEL, extractFieldsInPage } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGE = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <ul>
    <li><div style="display:inline-flex">
      <span>Is this request for a capital construction project for the City of Miami? (Yes / No) </span>
      <label for="Yes">Yes</label><input id="bolIsCityProject" name="bolIsCityProject" type="radio" value="">
      <label for="No">No</label><input id="bolIsCityProject" name="bolIsCityProject" type="radio" value="">
    </div></li>
    <li><div style="display:inline-flex">
      <span>Does this project offer any affordable housing benefits? (Yes / No) </span>
      <label for="Yes">Yes</label><input id="bolIsAffordableHousing" name="bolIsAffordableHousing" type="radio" value="">
      <label for="No">No</label><input id="bolIsAffordableHousing" name="bolIsAffordableHousing" type="radio" value="">
    </div></li>
  </ul>

  <!-- Miami's WORK ITEM list: the words are in a FOLLOWING div, sibling of the checkbox's
       PARENT, and the trade group is a plain <div> above the list. Four of these reached the
       planner as "chkTradeItem", it ticked none, and the portal said "Please select at least
       one work item". For a SOLAR permit the roofing group is the one NOT to tick, which is
       why the group heading matters as much as the item name. -->
  <div class="cldvSeparatorSNoB">ROOF NEW OR REPLACE</div>
  <ul class="max-ui">
    <li>
      <input id="TradeItemList_0__WorkItemDescription" name="TradeItemList[0].WorkItemDescription" type="hidden" value="">
      <div class="chkZone"><input id="chkTradeItem_367" name="chkTradeItem" class="chkSelectItem" type="checkbox" value=""></div>
      <div class="Zonelbl">FLAT ROOF</div>
      <input name="chkApItem" type="checkbox" style="display: none;" value="">
    </li>
    <li>
      <input id="TradeItemList_1__WorkItemDescription" name="TradeItemList[1].WorkItemDescription" type="hidden" value="">
      <div class="chkZone"><input id="chkTradeItem_523" name="chkTradeItem" class="chkSelectItem" type="checkbox" value=""></div>
      <div class="Zonelbl">SHINGLE ROOF</div>
    </li>
  </ul>

  <!-- MUST NOT CHANGE: a properly labelled radio keeps its own label. -->
  <label for="mountRoof">Roof mount</label><input type="radio" id="mountRoof" name="mount">

  <!-- MUST NOT CHANGE: a TEXT input's neighbouring word is a prompt, not its value. -->
  <label for="realLabel">Owner Name</label><input type="text" id="realLabel" name="ownerName">
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
const radios = raws.filter((f) => f.fieldType === "radio");
console.log(`   ${JSON.stringify(radios.map((f) => `${f.name}=${f.label} @ ${(f.section ?? "").slice(0, 40)}`))}`);

const city = radios.filter((f) => f.name === "bolIsCityProject");
const housing = radios.filter((f) => f.name === "bolIsAffordableHousing");

check("a Yes/No pair reads as Yes and No, not as two of the same control",
  city.length === 2 && city[0].label === "Yes" && city[1].label === "No",
  `got ${JSON.stringify(city.map((f) => f.label))} — the planner cannot answer a question whose two answers look identical`);
check("...and the QUESTION is the section, so three pairs on one page are distinguishable",
  /capital construction project/i.test(String(city[0]?.section ?? "")),
  `got ${JSON.stringify(city[0]?.section)}`);
check("...and the second question carries its own",
  /affordable housing/i.test(String(housing[0]?.section ?? "")) && housing[0]?.label === "Yes",
  `got ${JSON.stringify(housing[0]?.section)} / ${JSON.stringify(housing[0]?.label)}`);

// --- WORK ITEMS: the label follows the control, and the trade group is a bare div --------
const items = raws.filter((f) => f.name === "chkTradeItem");
console.log(`   work items: ${JSON.stringify(items.map((f) => `${f.label} @ ${f.section}`))}`);
check("a checkbox labelled by the div AFTER it reads as the work item, not as its name",
  items.length === 2 && items[0].label === "FLAT ROOF" && items[1].label === "SHINGLE ROOF",
  `got ${JSON.stringify(items.map((f) => f.label))} — as "chkTradeItem" the planner ticked none of four`);
check("...and the trade group above the list is the section",
  /ROOF NEW OR REPLACE/i.test(String(items[0]?.section ?? "")),
  `got ${JSON.stringify(items[0]?.section)} — for a solar permit the roofing group is the one NOT to tick`);

// --- MUST NOT CHANGE ------------------------------------------------------------------
const mount = raws.find((f) => f.id === "mountRoof");
check("a properly labelled radio keeps its own label",
  mount?.label === "Roof mount",
  `got ${JSON.stringify(mount?.label)}`);
const owner = raws.find((f) => f.id === "realLabel");
check("a text input is untouched — its neighbouring word is a prompt, not a value",
  owner?.label === "Owner Name",
  `got ${JSON.stringify(owner?.label)}`);

await browser.close();
server.close();
console.log(failures === 0 ? "choiceLabel.dom.smoke: PASS" : `choiceLabel.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
