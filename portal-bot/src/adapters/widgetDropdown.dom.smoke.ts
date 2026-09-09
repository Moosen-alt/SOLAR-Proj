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
import { EXTRACT_SEL, extractFieldsInPage, hasVisibleWidgetFaceInPage } from "./autoLearnAdapter";
import { selectWithFallback, readClosedComboboxOptions } from "../comboboxFill";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGE = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <!-- The portal's GLOBAL site search, which sits on every page of Miami's iBuild and
       carries the same attributes the combobox filler looks for in a popup's filter box.
       Present here on purpose: a page-global fallback that types the answer into an
       unrelated control is worse than not typing at all. -->
  <input class="form-control k-input" id="acGlobalSearch" name="acGlobalSearch" type="text"
         role="combobox" aria-autocomplete="list" data-role="autocomplete"
         placeholder="Search by Address, Process Number, Permit Number or Menu Option...">

  <!-- The portal's TOP NAVIGATION, permanently on screen. Telerik renders it as
       <ul class="t-menu">, which matches the popup-container list — so "the last visible
       popup" answered "what does this dropdown offer?" with the site menu on two of three
       dropdowns read on Miami's live Contact Information page. -->
  <ul id="Menu" class="t-widget t-reset t-header t-menu">
    <li class="t-item">Start Application</li>
    <li class="t-item">Manage Application</li>
    <li class="t-item">Contractor</li>
    <li class="t-item">Inspections</li>
  </ul>

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

  <!-- A widget whose click opens NOTHING — inert, or waiting on a cascade that has not
       fired. This is the case that produced Miami's worst read: nothing appeared, the
       scope fell back to "the last visible popup", and the site navigation was reported as
       the option list. "State" and "Company" both came back offering "Start Application,
       Manage Application, Contractor". -->
  <div id="inertWrap">
    <div id="inertTitle">Job Sub-Category (cascade)</div>
    <div class="t-widget t-dropdown"><div class="t-dropdown-wrap"><span class="t-input">Choose...</span></div>
      <input id="CascadeID" name="CascadeID" style="display:none" type="text"></div>
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

  <script>
    // Telerik's own behaviour, reproduced: the wrap opens a popup appended to <body>, and
    // picking an item writes the id into the hidden input and the text onto the face.
    var CATS = [["1","Addition and remodeling"],["2","Demolition"],["3","New construction"],["4","Remodeling/repairs"]];
    // Telerik closes on Escape and toggles closed on a second click of its own wrap.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { var b = document.querySelector(".t-animation-container"); if (b) b.remove(); }
    });
    document.querySelector("#dvjcCategoryleft .t-dropdown-wrap").addEventListener("click", function () {
      var open = document.querySelector(".t-animation-container");
      if (open) { open.remove(); return; }
      var box = document.createElement("div");
      box.className = "t-animation-container";
      box.style.cssText = "position:absolute;top:120px;left:8px;background:#fff;border:1px solid #ccc;z-index:99";
      var ul = document.createElement("ul");
      ul.className = "t-list t-reset";
      CATS.forEach(function (c) {
        var li = document.createElement("li");
        li.className = "t-item";
        li.textContent = c[1];
        li.addEventListener("click", function () {
          document.getElementById("JobCategoryID").value = c[0];
          document.querySelector("#dvjcCategoryleft .t-input").textContent = c[1];
          box.remove();
        });
        ul.appendChild(li);
      });
      box.appendChild(ul);
      document.body.appendChild(box);
    });
  </script>
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

// ---------------------------------------------------------------------------
// AND THEN ACTUALLY FILL IT. Classifying the control correctly is half the job; the value
// still has to land. Telerik opens on a click to the visible FACE — the hidden input has no
// bounding box, so Playwright cannot click it — and renders its options into a body-level
// animation container that names nothing menu, option or listbox.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// THE FILL PATH REFUSES INVISIBLE CONTROLS, AND IT IS RIGHT TO — one display:none date
// input inside a 0x0 container once cost 137 seconds and recorded nothing. But a dropdown
// widget's backing input is MEANT to be invisible, and Miami's Job Category was refused
// there three visits running with "hidden_field_skipped: Job Category" — after the options
// had been read and the planner had answered with an exact match off the menu.
// ---------------------------------------------------------------------------
const isWidgetBacked = async (sel: string): Promise<boolean> =>
  await page.locator(sel).evaluate(hasVisibleWidgetFaceInPage).catch(() => false) as boolean;

check("a dropdown widget's backing input is recognised despite being invisible",
  await isWidgetBacked("#JobCategoryID"),
  "the fill path will refuse it as a hidden field and never reach the combobox");
check("...and so is Kendo's",
  await isWidgetBacked("#JobSubCategoryID"),
  "");
check("MUST EXCLUDE: ordinary hidden form state is not widget-backed",
  !(await isWidgetBacked("#IsMiniIntake")),
  "the 137-second lesson has to keep applying to genuinely hidden fields");
check("MUST EXCLUDE: a dropdown-ish container with nothing showing is not widget-backed",
  !(await isWidgetBacked("#menuState")),
  "");

// FIRST, ASK IT WHAT IT OFFERS. A widget that renders its list only on click reaches the
// planner as a select with no options, so the planner has to invent a value — which is why
// Miami's Job Category stayed empty through three visits even after it was classified
// correctly. Nothing matched, and nothing said so.
const offered = await readClosedComboboxOptions(page, page.locator("#JobCategoryID"));
console.log(`   options read from the closed widget: ${JSON.stringify(offered)}`);
check("a dropdown that renders its list only on click can still be asked what it offers",
  offered.includes("Remodeling/repairs") && offered.length === 4,
  `got ${JSON.stringify(offered)}`);
check("...and the site NAVIGATION is not mistaken for the menu",
  !offered.some((o) => /Start Application|Manage Application|Inspections/i.test(o)),
  `got ${JSON.stringify(offered)} — a popup already on screen is not the one we just opened`);
check("...and the placeholder is not one of the choices",
  !offered.some((o) => /please select/i.test(o)),
  `got ${JSON.stringify(offered)}`);
check("...and it is left CLOSED — an open popup covers whatever the walk clicks next",
  (await page.locator(".t-animation-container").count()) === 0,
  "the popup was still open after reading");

// THE WORST READ OF ALL: nothing opened, and the site menu was reported as the answer.
const fromInert = await readClosedComboboxOptions(page, page.locator("#CascadeID"));
console.log(`   options read from a widget that opens nothing: ${JSON.stringify(fromInert)}`);
check("a widget that opens nothing offers nothing — not the site navigation",
  fromInert.length === 0,
  `got ${JSON.stringify(fromInert)} — this is the read that told the planner "State" offers "Start Application"`);

const filled = await selectWithFallback(page, page.locator("#JobCategoryID"), "Remodeling/repairs");
const landedValue = await page.locator("#JobCategoryID").inputValue().catch(() => "");
const landedFace = (await page.locator("#dvjcCategoryleft .t-input").textContent().catch(() => "")) ?? "";
console.log(`   fill reported ${filled}; hidden input = ${JSON.stringify(landedValue)}; face = ${JSON.stringify(landedFace)}`);

check("the value lands in the hidden input the form actually posts",
  landedValue === "4",
  `got ${JSON.stringify(landedValue)} — the widget never opened, or the option was never clicked`);
check("...and the widget shows it, which is what a person would check",
  /Remodeling\/repairs/.test(landedFace),
  `face reads ${JSON.stringify(landedFace)}`);
check("...and the fill reports success rather than a silent miss",
  filled === true,
  "selectWithFallback returned false while the value landed, or the value never landed");
check("...and the portal's global site search was NOT typed into",
  (await page.locator("#acGlobalSearch").inputValue().catch(() => "")) === "",
  "the filler fell back to a page-global search box and typed the answer into the site search");

// ---------------------------------------------------------------------------
// AND WHEN NOTHING MATCHES. A fill that cannot find its option must fail QUIETLY: the
// fall-through used to read the page-global search box and press Enter, which on this
// portal fires the site search and navigates the walk out of a half-filled form.
// ---------------------------------------------------------------------------
const missed = await selectWithFallback(page, page.locator("#JobCategoryID"), "Nothing On This Menu");
const afterMiss = await page.locator("#acGlobalSearch").inputValue().catch(() => "");
check("a value the menu does not offer is a quiet miss, not a guess",
  missed === false,
  "reported success for a value that is not on the menu");
check("...and the miss does not fire the portal's site search",
  afterMiss === "",
  `site search holds ${JSON.stringify(afterMiss)} — the fall-through read a box outside the widget`);
check("...and the value that DID land is still there",
  (await page.locator("#JobCategoryID").inputValue().catch(() => "")) === "4",
  "the failed attempt clobbered the good value");

await browser.close();
server.close();
console.log(failures === 0 ? "widgetDropdown.dom.smoke: PASS" : `widgetDropdown.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
