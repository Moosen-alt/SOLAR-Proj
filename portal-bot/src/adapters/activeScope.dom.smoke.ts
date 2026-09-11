// ONE ACTIVE SCOPE PER PAGE — scope the HARVEST, never the page's exits.
//
// ComEd (interconnect.comed.com, a NEM portal, and its platform twin peco.connectthegrid.com)
// opens the application in a DRAWER over the dashboard and leaves the dashboard mounted
// behind it. The banked census is one list for both:
//
//   p2 "ConnectTheGrid" [interconnect.comed.com/applications] form
//      fields=55(fill=28,btn=27,link=6) plan:nav=- adv=- fills=7 review=false
//   p3 "ConnectTheGrid" [interconnect.comed.com/applications] form
//      fields=55(fill=28,btn=27,link=6) plan:nav=26 adv=- fills=0 review=false
//
// — the drawer's 28 fillables PLUS the dashboard's 27 buttons. Handed that, the planner
// picked nav=26, "New Application Button. This will open a popup drawer.", and RE-OPENED the
// drawer instead of advancing inside it.
//
// This file pins the fix in BOTH directions, because a scope filter fails both ways:
//
//   MUST PASS  — a dashboard behind an open [role=dialog][aria-modal=true] is harvested
//                DIALOG-ONLY, and the advance taken is the dialog's own control.
//   MUST PASS  — THE HOLE: a panel owns the fields and the ONLY Next lives in a sticky
//                footer OUTSIDE it. The walk must find that Next and reach page 2, and must
//                NOT fall back to the panel's own Submit / bank the step as a review screen.
//   MUST PASS  — the narrowing: the same exemption must NOT hand back the dashboard's
//                "New Application Button", its "Next page" paginator, or its record actions.
//   MUST PASS  — a review panel's Submit in an outside footer IS re-admitted (recorded,
//                never clicked) — the asymmetry between the gate and the re-admission.
//   MUST PASS  — a plain single-form page with no panel behaves EXACTLY as before.
//   AGREEMENT  — the harvest's scope and advanceSignatureOf's scope are the same element.
//   KILL TEST  — AUTOLEARN_NO_ACTIVE_SCOPE=1 and the first harvest really does carry the
//                whole dashboard again, which is what makes the first check a test at all.
//
//   npx tsx portal-bot/src/adapters/activeScope.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import {
  AutoLearnAdapter,
  EXTRACT_SEL,
  extractFieldsInPage,
  applyActiveScopeFilter,
  resolveActiveScope,
  advanceSignatureOf,
  type LearnPlanner,
  type RawField,
} from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const STYLE = `<style>
  body{font:14px sans-serif;margin:0;padding:12px}
  .panel{position:fixed;top:20px;right:20px;width:420px;height:420px;background:#fff;
         border:1px solid #999;padding:12px;overflow:auto}
  .footer{position:fixed;left:0;right:0;bottom:0;height:56px;background:#eee;padding:10px}
</style>`;

// The ComEd shape, reduced to its bones: an icon-only dashboard (labels live in aria-label,
// visible text is a Material ligature) with a mat-paginator, and the application in a drawer
// on top of it. The dashboard carries a "Continue" of its own — a decoy that an unscoped
// harvest hands to the fallback finder before the drawer's real Next.
const DASHBOARD_BEHIND = `
  <h1>ConnectTheGrid</h1>
  <label for="dashSearch">Search applications</label>
  <input id="dashSearch" name="dashSearch" type="text">
  <select id="dashFilter" name="dashFilter"><option>All</option><option>Draft</option></select>
  <button class="mat-icon-button" aria-label="New Application Button. This will open a popup drawer.">
    <span class="material-icons">add</span></button>
  <button class="mat-icon-button" aria-label="Next page"><span class="material-icons">navigate_next</span></button>
  <button class="mat-icon-button" aria-label="Previous page"><span class="material-icons">navigate_before</span></button>
  <button id="dashContinue" onclick="window.__clicked='dashContinue'">Continue</button>
  <button>My Records</button>
  <button>Pay Fees Due</button>
  <button>Help</button>
  <button>Sign Out</button>
  <table><tr><td>REQ-1001</td></tr><tr><td>REQ-1002</td></tr></table>`;

const PAGES: Record<string, string> = {
  // ---- 1) drawer over dashboard --------------------------------------------------------
  "/drawer": `<!doctype html><html><body>${STYLE}
    ${DASHBOARD_BEHIND}
    <div role="dialog" aria-modal="true" class="panel">
      <h2>New Interconnection Application</h2>
      <label for="dlgName">Customer Name</label><input id="dlgName" name="dlgName" type="text">
      <label for="dlgEmail">Customer Email</label><input id="dlgEmail" name="dlgEmail" type="text">
      <label for="dlgPhone">Customer Phone</label><input id="dlgPhone" name="dlgPhone" type="text">
      <button id="dlgNext" onclick="window.__clicked='dlgNext';location.href='/p2'">Next</button>
      <button id="dlgCancel">Cancel</button>
    </div>
  </body></html>`,

  // ---- 2) THE HOLE: the panel owns the fields, the footer owns the only Next ------------
  // A mainstream SPA wizard layout. The panel's own Submit is there ON PURPOSE: it is what
  // the engine wrongly reached for when the footer Next was filtered away.
  "/sticky": `<!doctype html><html><body>${STYLE}
    <h1>Interconnection Request — Step 1 of 5</h1>
    <div role="dialog" class="panel" id="stepBody">
      <h2>Site Information</h2>
      <label for="siteAddr">Service Address</label><input id="siteAddr" name="siteAddr" type="text">
      <label for="siteCity">Service City</label><input id="siteCity" name="siteCity" type="text">
      <!-- The next step, pre-rendered and retired. In the scope, and unreachable. The
           retired "Next" in here must not count as "the panel owns a way forward" either,
           or the exemption stays shut and the real footer Next is lost. -->
      <div aria-hidden="true">
        <label for="ghostField">Ghost Field</label><input id="ghostField" name="ghostField" type="text">
        <button id="ghostPanelNext" onclick="location.href='/wrong'">Next</button>
      </div>
      <button id="panelSubmit" onclick="location.href='/wrong'">Submit</button>
      <button id="panelCancel">Cancel</button>
    </div>
    <div class="footer">
      <button id="footerBack">Back</button>
      <button id="footerNext" onclick="location.href='/p2'">Next</button>
      <!-- Outside the panel AND retired: the exemption is open on this page, and this must
           still not come back through it. -->
      <span aria-hidden="true"><button id="ghostContinue" onclick="location.href='/wrong'">Continue</button></span>
      <button class="mat-icon-button" aria-label="New Application Button. This will open a popup drawer.">
        <span class="material-icons">add</span></button>
      <button class="mat-icon-button" aria-label="Next page"><span class="material-icons">navigate_next</span></button>
      <button>My Records</button>
      <button>Pay Fees Due</button>
    </div>
  </body></html>`,

  // ---- 3) a review panel whose Submit lives in the outside footer -----------------------
  "/reviewfooter": `<!doctype html><html><body>${STYLE}
    <h1>Interconnection Request — Step 5 of 5</h1>
    <div role="dialog" class="panel">
      <h2>Review</h2>
      <label for="ackBox">I certify the information above is correct</label>
      <input id="ackBox" name="ackBox" type="checkbox">
    </div>
    <div class="footer">
      <button id="footerSubmit">Submit Application</button>
      <button>My Records</button>
    </div>
  </body></html>`,

  // ---- 4) a plain single-form page, no panel anywhere -----------------------------------
  "/plain": `<!doctype html><html><body>${STYLE}
    <h1>Permit Application — Step 1 of 3</h1>
    <label for="ownerName">Owner Name</label><input id="ownerName" name="ownerName" type="text">
    <label for="ownerCity">Owner City</label><input id="ownerCity" name="ownerCity" type="text">
    <select id="permitType" name="permitType"><option>Solar PV</option></select>
    <button id="plainNext" onclick="location.href='/p2'">Next</button>
    <button id="plainCancel">Cancel</button>
  </body></html>`,

  "/p2": `<!doctype html><html><body>${STYLE}
    <h1>Interconnection Request — Step 2 of 5</h1>
    <label for="sysKw">System Size kW</label><input id="sysKw" name="sysKw" type="text">
    <button id="p2Next">Next</button>
  </body></html>`,

  "/wrong": `<!doctype html><html><body>${STYLE}
    <h1>Application Filed</h1><p>This page must never be reached by automation.</p>
  </body></html>`,
};

const server = http.createServer((q, r) => {
  const body = PAGES[(q.url || "/").split("?")[0]] ?? "<!doctype html><html><body>404</body></html>";
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
// The esbuild keepNames transform wraps nameable functions as __name(fn); a raw page has no
// such global, and the surrounding .catch() would turn the ReferenceError into "found
// nothing". openPortal injects the same shim in production.
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

/** The single-frame equivalent of extractAllFrames: resolve the one scope, harvest, filter. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function harvest(page: any): Promise<{ marked: boolean; labels: string[]; raws: RawField[]; exempted: string[] }> {
  const scope = await resolveActiveScope(page);
  const raws = (await page.$$eval(EXTRACT_SEL, extractFieldsInPage)) as RawField[];
  const out = applyActiveScopeFilter(raws, scope.marked);
  return { marked: scope.marked, labels: out.fields.map((f) => f.label), raws: out.fields, exempted: out.exempted };
}

const NEW_APP = "New Application Button. This will open a popup drawer.";

// ===========================================================================================
// 1) MUST PASS — dashboard behind an open modal dialog: the harvest is DIALOG-ONLY.
// ===========================================================================================
console.log("\n[1] drawer over dashboard");
const p1 = await ctx.newPage();
await p1.goto(`${base}/drawer`);
const h1 = await harvest(p1);
check("a real open panel resolves as the active scope", h1.marked, "no scope resolved — nothing below is being tested");
check("the drawer's three fillables survive",
  ["Customer Name", "Customer Email", "Customer Phone"].every((l) => h1.labels.includes(l)),
  JSON.stringify(h1.labels));
check("the dashboard's own input BEHIND the drawer is gone",
  !h1.labels.includes("Search applications") && !h1.raws.some((f) => f.name === "dashSearch" || f.name === "dashFilter"),
  JSON.stringify(h1.labels));
check(`the dashboard's ${JSON.stringify(NEW_APP.slice(0, 28) + "…")} is gone — this is the control the planner picked as nav=26`,
  !h1.labels.includes(NEW_APP), JSON.stringify(h1.labels));
check("the dashboard's decoy 'Continue' is gone (the drawer owns the way forward)",
  !h1.labels.includes("Continue"), JSON.stringify(h1.labels));
check("nothing was exempted — the drawer holds its own Next, so the exemption must not fire",
  h1.exempted.length === 0, JSON.stringify(h1.exempted));

// AGREEMENT — the movement signature must measure the SAME element the harvest did, or the
// two drift and a drawer advance is judged against the dashboard behind it.
const sig1 = await advanceSignatureOf(p1);
const markedId = await p1.evaluate(() => {
  const el = document.querySelector('[data-al-activescope="1"]');
  return el ? `${el.tagName.toLowerCase()}#${el.id}.${(el.getAttribute("class") || "").trim()}` : "";
});
const sigParts = sig1.split("|");
check("the signature says it is scoped (field 2 === 's')", sigParts[1] === "s", `signature=${sig1}`);
check("the signature's fillables are the drawer's, not the dashboard's",
  sig1.includes("dlgname") && sig1.includes("dlgemail") && sig1.includes("dlgphone")
  && !sig1.includes("dashsearch") && !sig1.includes("dashfilter"),
  `signature=${sig1}`);
check("the signature's enabled-button count is the drawer's 2, not the dashboard's 9",
  sigParts[3] === "2", `signature=${sig1}`);
check("and the element it measured is the same panel the harvest marked",
  markedId.startsWith("div#") && markedId.includes("panel"), `marked=${markedId}`);

// THE WALK: the advance actually taken must be the drawer's own control.
const seen1: string[][] = [];
const planner1: LearnPlanner = async (req) => {
  seen1.push(req.fields.map((f) => f.label));
  const fills: Array<{ selectorIndex: number; value: string }> = [];
  const want: Record<string, string> = {
    "Customer Name": "Ada Lovelace", "Customer Email": "a@example.com", "Customer Phone": "555-0100",
  };
  req.fields.forEach((f, i) => { if (want[f.label]) fills.push({ selectorIndex: i, value: want[f.label] }); });
  return { fills, atReview: false };
};
const pw1 = await ctx.newPage();
await pw1.goto(`${base}/drawer`);
const a1 = new AutoLearnAdapter("Active Scope Drawer", planner1, { maxPages: 2 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(a1 as any).page = pw1;
const r1 = await a1.learn(
  { portalUrl: `${base}/drawer` } as never,
  { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "T" } as never,
);
check("the planner was never offered the dashboard's New Application control",
  seen1.length > 0 && !seen1[0].includes(NEW_APP), JSON.stringify(seen1[0] ?? []));
check("the advance taken was the DRAWER's own Next, not the dashboard's Continue",
  pw1.url().endsWith("/p2"),
  `ended on ${pw1.url()}; steps=${JSON.stringify(r1.steps.filter((s) => s.action === "click").map((s) => s.note))}`);

// ===========================================================================================
// 2) MUST PASS — THE HOLE. The panel owns the fields; the only Next is in a sticky footer.
// ===========================================================================================
console.log("\n[2] the hole: panel owns the fields, footer owns the only Next");
const p2 = await ctx.newPage();
await p2.goto(`${base}/sticky`);
const h2 = await harvest(p2);
check("the panel resolves as the active scope", h2.marked);
check("the panel's fields survive",
  h2.labels.includes("Service Address") && h2.labels.includes("Service City"), JSON.stringify(h2.labels));
check("THE HOLE: the footer's Next — outside the panel — is still in the harvest",
  h2.raws.some((f) => f.id === "footerNext"),
  `labels=${JSON.stringify(h2.labels)} — a page's only way forward must never be filtered away`);
check("...and it got there by the EXEMPTION, not by accident",
  h2.exempted.includes("Next"), JSON.stringify(h2.exempted));
check("THE NARROWING: the exemption did NOT hand back the New Application control",
  !h2.labels.includes(NEW_APP), JSON.stringify(h2.exempted));
check("THE NARROWING: nor the mat-paginator (composes with PAGINATION_CONTROL, c86fc08)",
  !h2.labels.includes("Next page"), JSON.stringify(h2.exempted));
check("THE NARROWING: nor the record actions behind the panel",
  !h2.labels.includes("My Records") && !h2.labels.includes("Pay Fees Due"), JSON.stringify(h2.exempted));
check("THE NARROWING: nor a plain outside 'Back'",
  !h2.labels.includes("Back"), JSON.stringify(h2.exempted));
check("OFFSTAGE, INSIDE the panel: an aria-hidden field is dropped from the harvest too",
  !h2.labels.includes("Ghost Field") && !h2.raws.some((f) => f.name === "ghostField"),
  JSON.stringify(h2.labels));
check("OFFSTAGE, INSIDE the panel: a retired 'Next' does not count as the panel owning a way forward",
  !h2.raws.some((f) => f.id === "ghostPanelNext") && h2.exempted.includes("Next"),
  `exempted=${JSON.stringify(h2.exempted)} — counting it shuts the exemption and loses the real footer Next`);
check("OFFSTAGE, OUTSIDE the panel: an aria-hidden 'Continue' is not re-admitted, exemption open or not",
  h2.raws.filter((f) => f.label === "Continue").length === 0,
  `exempted=${JSON.stringify(h2.exempted)} — a control the page retired is not a way forward`);

const seen2: string[][] = [];
const planner2: LearnPlanner = async (req) => {
  seen2.push(req.fields.map((f) => f.label));
  const fills: Array<{ selectorIndex: number; value: string }> = [];
  const want: Record<string, string> = { "Service Address": "1 Test St", "Service City": "Springfield" };
  req.fields.forEach((f, i) => { if (want[f.label]) fills.push({ selectorIndex: i, value: want[f.label] }); });
  return { fills, atReview: false };
};
const pw2 = await ctx.newPage();
await pw2.goto(`${base}/sticky`);
const a2 = new AutoLearnAdapter("Active Scope Sticky Footer", planner2, { maxPages: 2 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(a2 as any).page = pw2;
const r2 = await a2.learn(
  { portalUrl: `${base}/sticky` } as never,
  { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "T" } as never,
);
check("the walk REACHED page 2 through the footer Next",
  pw2.url().endsWith("/p2"),
  `ended on ${pw2.url()}; steps=${JSON.stringify(r2.steps.filter((s) => s.action === "click").map((s) => s.note))}`);
check("it did NOT fall back to the panel's own Submit (that lands on /wrong — a filing)",
  !pw2.url().endsWith("/wrong"), `ended on ${pw2.url()}`);
check("it recorded the footer Next as the advance",
  r2.steps.some((s) => s.action === "click" && /advance: Next\b/.test(String(s.note ?? ""))),
  JSON.stringify(r2.steps.map((s) => s.note)));
check("it did NOT bank a mid-flow 'Step 1 of 5' page as a review/final-submit screen",
  !r2.steps.some((s) => s.isFinalSubmit) && seen2.length >= 2,
  `pages planned=${seen2.length} finalSubmit=${r2.steps.filter((s) => s.isFinalSubmit).length}`);
check("the planner saw the second page, so the page was actually LEARNED",
  (seen2[1] ?? []).includes("System Size kW"), JSON.stringify(seen2[1] ?? []));

// ===========================================================================================
// 3) MUST PASS — the asymmetry: a review panel's Submit in an outside footer IS re-admitted.
// ===========================================================================================
console.log("\n[3] a review panel's Submit lives outside the panel");
const p3 = await ctx.newPage();
await p3.goto(`${base}/reviewfooter`);
const h3 = await harvest(p3);
check("the review panel resolves as the active scope", h3.marked);
check("the footer's 'Submit Application' is re-admitted — a recipe with no final step is unusable",
  h3.labels.includes("Submit Application"), `labels=${JSON.stringify(h3.labels)} exempted=${JSON.stringify(h3.exempted)}`);
check("...but the record action next to it is still refused",
  !h3.labels.includes("My Records"), JSON.stringify(h3.labels));

// ===========================================================================================
// 4) MUST PASS — a plain page with no panel behaves EXACTLY as before.
// ===========================================================================================
console.log("\n[4] a plain single-form page");
const p4 = await ctx.newPage();
await p4.goto(`${base}/plain`);
const h4 = await harvest(p4);
const rawPlain = (await p4.$$eval(EXTRACT_SEL, extractFieldsInPage)) as RawField[];
check("no panel — no scope resolved", !h4.marked);
check("the harvest is byte-for-byte the unscoped harvest",
  JSON.stringify(h4.labels) === JSON.stringify(rawPlain.map((f) => f.label)),
  `scoped=${JSON.stringify(h4.labels)} unscoped=${JSON.stringify(rawPlain.map((f) => f.label))}`);
check("no field carries a scope opinion at all",
  rawPlain.every((f) => f.inActiveScope === undefined && f.offstage === undefined),
  JSON.stringify(rawPlain.map((f) => [f.label, f.inActiveScope])));
const sig4 = await advanceSignatureOf(p4);
check("the signature says it is unscoped (field 2 === 'd')", sig4.split("|")[1] === "d", `signature=${sig4}`);

const seen4: string[][] = [];
const planner4: LearnPlanner = async (req) => {
  seen4.push(req.fields.map((f) => f.label));
  const fills: Array<{ selectorIndex: number; value: string }> = [];
  const want: Record<string, string> = { "Owner Name": "Ada Lovelace", "Owner City": "Springfield" };
  req.fields.forEach((f, i) => { if (want[f.label]) fills.push({ selectorIndex: i, value: want[f.label] }); });
  return { fills, atReview: false };
};
const pw4 = await ctx.newPage();
await pw4.goto(`${base}/plain`);
const a4 = new AutoLearnAdapter("Active Scope Plain", planner4, { maxPages: 2 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(a4 as any).page = pw4;
await a4.learn(
  { portalUrl: `${base}/plain` } as never,
  { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "T" } as never,
);
check("the plain page still fills and still advances",
  pw4.url().endsWith("/p2"), `ended on ${pw4.url()}`);

// ===========================================================================================
// 5) KILL TEST — turn scoping off and the bug must come back, or check [1] proves nothing.
// ===========================================================================================
console.log("\n[5] kill test: AUTOLEARN_NO_ACTIVE_SCOPE=1");
process.env.AUTOLEARN_NO_ACTIVE_SCOPE = "1";
const pk = await ctx.newPage();
await pk.goto(`${base}/drawer`);
const hk = await harvest(pk);
check("with scoping disabled, no scope is resolved", !hk.marked);
check("...and the harvest really does carry the dashboard BEHIND the drawer (the bug is real)",
  hk.labels.includes(NEW_APP) && hk.labels.includes("Search applications") && hk.labels.includes("Continue"),
  `labels=${JSON.stringify(hk.labels)} — if this passes with scoping ON, check [1] is not a test`);
check("...and the drawer's fields are in the SAME list — one census for two contexts",
  hk.labels.includes("Customer Name") && hk.labels.length > h1.labels.length,
  `unscoped=${hk.labels.length} scoped=${h1.labels.length}`);
const sigk = await advanceSignatureOf(pk);
check("...and the movement signature falls back to the whole document too",
  sigk.split("|")[1] === "d" && sigk.includes("dashsearch"), `signature=${sigk}`);
delete process.env.AUTOLEARN_NO_ACTIVE_SCOPE;

await browser.close();
server.close();
console.log(failures === 0 ? "\nactiveScope.dom.smoke: PASS" : `\nactiveScope.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
