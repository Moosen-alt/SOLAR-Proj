// A HIDDEN INPUT INSIDE A DROPDOWN WIDGET IS A DROPDOWN.
//
// Miami's Job Category — the page that stops the walk with "Please select mandatory Job
// Category" — is a Telerik dropdown:
//
//   <div class="t-widget t-dropdown"><div class="t-dropdown-wrap">
//       <span class="t-input">Please select a Job Category...</span></div>
//     <input id="JobCategoryID" style="display:none" type="text"></div>
//
// The tag check calls that a TEXT field, applyFill's fill() throws on a hidden input, and
// the value drops in silence. The ARIA rule already in place does not help: Telerik predates
// ARIA and names nothing combobox or listbox. It is also the dropdown of choice across
// government portals, so this is not one page.
//
// And the label. Left alone this reaches the planner as "JobCategoryID"; the words a person
// reads, "*Job Category", are in a sibling of the widget's container that no label rule
// looks at.
//
// MUST EXCLUDE is the whole risk here: forms are full of hidden inputs holding state, and
// calling one a dropdown puts a value where no person could have typed it.
//
//   npx tsx portal-bot/src/adapters/widgetDropdown.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { EXTRACT_SEL, extractFieldsInPage } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGE = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <!-- Miami's markup, as captured. -->
  <div id="dvptCategory">
    <div id="dvjcCategoryleft" style="width:50%">
      <div id="dvtitleleft">*Job Category</div>
      <div class="dvjcddl">
        <div class="t-widget t-dropdown t-header" style="width:100%" tabindex="0">
          <div class="t-dropdown-wrap t-state-default"><span class="t-input">Please select a Job Category...</span><span class="t-select"><span class="t-icon t-arrow-down">select</span></span></div>
          <input data-val="true" data-val-required="Please select mandatory Job Category." id="JobCategoryID" name="JobCategoryID" style="display: none;" type="text">
        </div>
      </div>
    </div>
  </div>

  <!-- Kendo's newer skin, same shape. -->
  <div id="subWrap">
    <div id="subTitle">Job Sub-Category</div>
    <span class="k-widget k-dropdown"><span class="k-dropdown-wrap"><span class="k-input">Choose...</span></span>
      <input id="JobSubCategoryID" name="JobSubCategoryID" style="display:none" type="text"></span>
  </div>

  <!-- MUST EXCLUDE: ordinary hidden form state, no widget around it. -->
  <input type="hidden" id="__RequestVerificationToken" name="__RequestVerificationToken" value="tok">
  <input type="text" id="IsMiniIntake" name="IsMiniIntake" style="display:none" value="">

  <!-- MUST EXCLUDE: a hidden input that merely SITS in a container whose class says dropdown,
       with nothing visible showing a value — a collapsed menu's state, not a control. -->
  <div class="nav-dropdown"><input type="text" id="menuState" name="menuState" style="display:none"></div>

  <!-- MUST NOT CHANGE: a real, visible text input keeps being a text input. -->
  <label for="ownerName">Owner Name</label>
  <input type="text" id="ownerName" name="ownerName">
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
const by = new Map(raws.map((f) => [f.name ?? f.id ?? "", f]));
console.log(`   ${JSON.stringify(raws.map((f) => `${f.name}:${f.fieldType}:${f.label}`))}`);

check("a hidden input inside a Telerik dropdown is a SELECT, not a text field",
  by.get("JobCategoryID")?.fieldType === "select",
  `got ${by.get("JobCategoryID")?.fieldType} — as "text" the fill throws on a hidden input and the value drops in silence`);
check("...and it is named by the words on the page, not by its id",
  by.get("JobCategoryID")?.label === "Job Category",
  `got ${JSON.stringify(by.get("JobCategoryID")?.label)}`);
check("Kendo's skin is the same widget",
  by.get("JobSubCategoryID")?.fieldType === "select" && by.get("JobSubCategoryID")?.label === "Job Sub-Category",
  `got ${by.get("JobSubCategoryID")?.fieldType} / ${JSON.stringify(by.get("JobSubCategoryID")?.label)}`);

// --- MUST EXCLUDE ---------------------------------------------------------------------
check("an anti-forgery token is not a dropdown",
  by.get("__RequestVerificationToken") === undefined || by.get("__RequestVerificationToken")?.fieldType !== "select",
  `got ${by.get("__RequestVerificationToken")?.fieldType}`);
check("hidden form state with no widget around it is not a dropdown",
  by.get("IsMiniIntake")?.fieldType !== "select",
  `got ${by.get("IsMiniIntake")?.fieldType} — Miami's own page carries three of these`);
check("a hidden input in a dropdown-ish container showing NO value is not a dropdown",
  by.get("menuState")?.fieldType !== "select",
  `got ${by.get("menuState")?.fieldType} — the visible face is what makes it a control`);
check("a real visible text input is untouched",
  by.get("ownerName")?.fieldType === "text" && by.get("ownerName")?.label === "Owner Name",
  `got ${by.get("ownerName")?.fieldType} / ${JSON.stringify(by.get("ownerName")?.label)}`);

await browser.close();
server.close();
console.log(failures === 0 ? "widgetDropdown.dom.smoke: PASS" : `widgetDropdown.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
