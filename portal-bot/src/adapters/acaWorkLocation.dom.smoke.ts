// ACA ON A CUSTOM DOMAIN (B5) AND THE WORK-LOCATION SEARCH BY THE PANEL'S OWN BUTTON — ADDRESS
// AND PARCEL (close3 made Enter in "Parcel Number" a refusal; Lee County looks up by parcel,
// no dashes).
//
// A SYNTHETIC Accela Citizen Access flow served under /permits on 127.0.0.1 — no "accela.com",
// no "citizenaccess" anywhere in the URL, exactly like Columbus's portal.columbus.gov/permits.
// The pages carry ACA's own control ids (ctl00_PlaceHolderMain_…, termAccept, actionBarBottom,
// WorkLocationEdit_txtStreetNo4Search…, txtParcelNo, btnSearch). Disclaimer -> Enter Work Site
// Location -> Step 3 details -> "Step 4 : Review" (whose Continue Application files: POST
// /permits/Cap/CapConfirm.aspx). A document keydown counts every Enter pressed in a search box
// (a WebForms default button would fire it). Fake data only.
//
// MUST-PASS address (custom domain): the deterministic ACA passes run there — the disclaimer is
//           accepted by the pass, the address is searched by the panel's Search, a row picked,
//           the run reaches review; 0 Enter presses, 0 filing requests.
// MUST-PASS parcel (Lee shape: the address finds nothing): the SAME panel Search finds it by the
//           parcel, dashes removed; recorded bound to parcelNumber "(no dashes)", no literal;
//           reaches review; 0 Enter presses, 0 filing requests.
// MUST-PASS replay of the parcel recipe for ANOTHER parcel: the replay types THAT parcel without
//           dashes, clicks the panel Search, reaches review; 0 Enter, 0 filing requests.
//
// Run: npx tsx portal-bot/src/adapters/acaWorkLocation.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const P = "ctl00_PlaceHolderMain";
const CONT = `<div id="${P}_actionBarBottom"><a id="${P}_actionBarBottom_btnContinue" href="javascript:void(0);" class="ACA_LgButton"><span>Continue Application &raquo;</span></a></div>`;
const shell = (title: string, body: string, script = ""): string => `<!doctype html><html><head><title>${title}</title></head><body>
<div id="hdr"><a id="ctl00_HeaderNavigation_hlHome" href="/permits/Welcome.aspx">Home</a> <a id="ctl00_HeaderNavigation_hlSearch" href="/permits/Cap/CapHome.aspx?module=Permitting">Search</a></div>
<form id="aspnetForm" method="post" action="#" onsubmit="return false">${body}</form>
<script>
var S = JSON.parse(sessionStorage.getItem("S") || '{"enters":0,"searches":0,"parcelSearched":""}');
function save(){ sessionStorage.setItem("S", JSON.stringify(S)); } window.__S = S;
document.addEventListener("keydown", function(e){ if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") { S.enters++; save(); } });
${script}
</script></body></html>`;

const MOD = "module=Permitting&TabName=Permitting";
const pages = (variant: string, path: string, q: URLSearchParams): string | null => {
  if (/CapApplyDisclaimer\.aspx$/i.test(path)) return shell("Online Application", `<h1>Online Application</h1>
    <div>General Disclaimer. Terms and Conditions of use of this portal.</div>
    <input type="checkbox" id="${P}_termAccept" name="ctl00$PlaceHolderMain$termAccept"><label for="${P}_termAccept">I have read and accepted the above terms.</label>
    ${CONT}`, `document.getElementById("${P}_actionBarBottom_btnContinue").onclick = function(){ if (document.getElementById("${P}_termAccept").checked) location.href = "/permits/Cap/CapEdit.aspx?stepNumber=2&${MOD}"; return false; };`);
  if (/CapEdit\.aspx$/i.test(path) && q.get("stepNumber") === "2") return shell("Enter Work Site Location", `<h1>Step 1: Location</h1><h2>Enter Work Site Location</h2>
    <table><tr><td><label>Street No.:</label> <input id="${P}_WorkLocationEdit_txtStreetNo4Search_ChildControl0" name="ctl00$PlaceHolderMain$WorkLocationEdit$txtStreetNo4Search$ChildControl0"> - <input id="${P}_WorkLocationEdit_txtStreetNo4Search_ChildControl1"></td></tr>
    <tr><td><label for="${P}_WorkLocationEdit_txtStreetName">Street Name:</label> <input id="${P}_WorkLocationEdit_txtStreetName"></td></tr>
    <tr><td><label for="${P}_WorkLocationEdit_txtParcelNo">Parcel Number:</label> <input id="${P}_WorkLocationEdit_txtParcelNo" name="ctl00$PlaceHolderMain$WorkLocationEdit$txtParcelNo"></td></tr></table>
    <a id="${P}_WorkLocationEdit_btnSearch" href="javascript:void(0);">Search</a> <a id="${P}_WorkLocationEdit_btnClear" href="javascript:void(0);">Clear</a>
    <div id="results"></div><div id="msg"></div>${CONT}`,
  `var V = ${JSON.stringify(variant)};
    var el = function(s){ return document.getElementById("${P}_" + s); };
    el("WorkLocationEdit_btnSearch").onclick = function(){
      S.searches++; save();
      var no = el("WorkLocationEdit_txtStreetNo4Search_ChildControl0").value.trim(), nm = el("WorkLocationEdit_txtStreetName").value.trim().toLowerCase(), pa = el("WorkLocationEdit_txtParcelNo").value.trim();
      var hit = (V === "address" && no === "100" && nm && "test park".indexOf(nm) === 0 && !pa)
             || (V === "parcel" && !no && !nm && (pa === "2645240000008.0000" || pa === "1122334400001.0000"));
      if (pa) { S.parcelSearched = pa; save(); }
      setTimeout(function(){
        document.getElementById("msg").textContent = hit ? "" : "Address not found.";
        document.getElementById("results").innerHTML = hit ? '<table id="${P}_WorkLocationEdit_gdvAddress"><tr><td><input type="radio" name="addr" id="r1"></td><td>100 TEST PARK RD FORT MYERS FL 33901</td><td>Parcel ' + pa + '</td></tr></table>' : "";
      }, 300);
      return false;
    };
    el("actionBarBottom_btnContinue").onclick = function(){ var r = document.getElementById("r1"); if (r && r.checked) location.href = "/permits/Cap/CapEdit.aspx?stepNumber=3&${MOD}"; else document.getElementById("msg").textContent = "Please select an address."; return false; };`);
  if (/CapEdit\.aspx$/i.test(path) && q.get("stepNumber") === "3") return shell("Project Details", `<h1>Step 3: Project Details</h1>
    <label for="${P}_txtJobValue">Job Value ($):</label> <input id="${P}_txtJobValue" name="ctl00$PlaceHolderMain$txtJobValue">${CONT}`,
  `document.getElementById("${P}_actionBarBottom_btnContinue").onclick = function(){ if (document.getElementById("${P}_txtJobValue").value) location.href = "/permits/Cap/CapConfirm.aspx?${MOD}"; return false; };`);
  if (/CapConfirm\.aspx$/i.test(path)) return shell("Review", `<h1>Step 4 : Review</h1><p>Please review all information below. Your application will not be submitted until you click Continue Application.</p>
    <p>Work location: 100 TEST PARK RD</p>${CONT}`,
  `document.getElementById("${P}_actionBarBottom_btnContinue").onclick = function(){ fetch("/permits/Cap/CapConfirm.aspx?submit=1", { method: "POST", body: "__EVENTTARGET=btnContinue" }).catch(function(){}); return false; };`);
  return null;
};

const posts: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET" && req.method !== "HEAD") { posts.push(url.pathname + url.search); res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
  const variant = (req.headers.cookie || "").match(/v=(\w+)/)?.[1] || "address";
  const html = pages(variant, url.pathname, url.searchParams);
  if (!html) { res.writeHead(404, { "content-type": "text/html" }); res.end("<h1>Not found</h1>"); return; }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const entry = `${base}/permits/Cap/CapApplyDisclaimer.aspx?${MOD}`;

// Tick every checkbox, give every text box its obvious value, advance by Continue Application.
const planner: LearnPlanner = async (req) => {
  const fills: Array<{ selectorIndex: number; value: string; field?: string }> = [];
  req.fields.forEach((f, i) => {
    const l = String(f.label ?? "");
    if (f.fieldType === "checkbox" || f.fieldType === "radio") fills.push({ selectorIndex: i, value: "true" });
    else if (f.fieldType === "text" && /job value/i.test(l)) fills.push({ selectorIndex: i, value: "20000", field: "valuation" });
  });
  const cont = req.fields.findIndex((f) => f.fieldType === "button" && /continue application/i.test(String(f.label ?? "")));
  return { fills, atReview: false, ...(cont >= 0 ? { advanceSelectorIndex: cont } : {}) };
};

const state = async (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("S") || "{}") as Record<string, unknown>).catch(() => ({} as Record<string, unknown>));
const project = (parcel: string) => ({ projectAddress: "100 Test Park Rd, Fort Myers, FL 33901", city: "Fort Myers", state: "FL", zip: "33901", homeownerName: "Test Owner", permitType: "structural", parserSnapshot: { parcelNumber: parcel } }) as unknown as ProjectRecord;

const browser = await chromium.launch();
let parcelSteps: RecipeStep[] = [];
try {
  for (const variant of ["address", "parcel"]) {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(8000);
    await ctx.addCookies([{ name: "v", value: variant, url: base }]);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(entry);
    posts.length = 0;
    const adapter = new AutoLearnAdapter("ACA Custom Domain Smoke", planner, { maxPages: 10, siteContactIdentity: { parcel: "26-45-24-00-00008.0000", lastName: "Owner" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).page = page;
    let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
    let threw = "";
    try { r = await adapter.learn({ portalUrl: entry } as never, project("26-45-24-00-00008.0000")); } catch (e) { threw = String(e).slice(0, 300); }
    const st = await state(page);
    const where = page.url();
    await ctx.close().catch(() => null);
    const steps = r?.steps ?? [];
    const notes = steps.map((s) => String(s.note ?? ""));
    const filings = posts.filter((p) => /CapConfirm/i.test(p)).length;
    const msg = String(r?.message ?? threw).slice(0, 400);
    check(`${variant}: 0 Enter presses in the search boxes, 0 filing requests`, st.enters === 0 && filings === 0, `enters=${String(st.enters)} filings=${filings} POSTs=[${posts.join(",")}]`);
    check(`MUST-PASS ${variant}: the ACA passes run on the custom domain — the disclaimer by the pass, the work location by the pass`,
      notes.includes("accela: accept entry terms") && notes.some((n) => /^work location: search$/.test(n)), `notes=${JSON.stringify(notes)}`);
    check(`MUST-PASS ${variant}: the walk reaches review (Step 4 : Review), the panel Search clicked`,
      r?.reachedReview === true && /CapConfirm/i.test(where) && Number(st.searches) >= 1, `reachedReview=${String(r?.reachedReview)} at=${where} searches=${String(st.searches)} ${msg}`);
    if (variant === "address") {
      check("MUST-PASS address: searched by street number + name, bound", notes.includes("work location: street number") && !notes.some((n) => /parcel/.test(n)), `notes=${JSON.stringify(notes)}`);
    } else {
      parcelSteps = steps;
      const pf = steps.find((s) => /parcel number \(no dashes\)/.test(String(s.note ?? "")));
      check("MUST-PASS parcel: found by the parcel, dashes removed, by the SAME panel Search (address first, then parcel)",
        st.parcelSearched === "2645240000008.0000" && Number(st.searches) >= 2, `parcelSearched=${String(st.parcelSearched)} searches=${String(st.searches)}`);
      check("MUST-PASS parcel: recorded bound to parcelNumber with NO literal, no street steps",
        !!pf && pf.field === "parcelNumber" && pf.value === undefined && !notes.includes("work location: street number") && !JSON.stringify(steps).includes("2645240000008"),
        `parcelStep=${JSON.stringify(pf)} notes=${JSON.stringify(notes)}`);
    }
  }

  // REPLAY the parcel recipe for ANOTHER property's parcel.
  const recipe = {
    id: "aca-parcel", scopeType: "ahj", profileKey: "fl|lee county|", state: "FL", ahj: "Lee County", utility: "",
    portalPlatform: "accela", portalUrl: entry, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
    steps: [...parcelSteps.filter((s) => !s.isFinalSubmit), { action: "stopForReview" } as RecipeStep],
  } as unknown as PortalRecipe;
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(8000);
  await ctx.addCookies([{ name: "v", value: "parcel", url: base }]);
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = await ctx.newPage();
  posts.length = 0;
  const adapter = new RecipeAdapter(recipe, { parcelNumber: "11-22-33-44-00001.0000", streetNumber: "100", streetNameCore: "Test Park", streetNameSearchPortion: "Tes", valuation: "20000" }, {}, {});
  (adapter as unknown as { page: unknown }).page = page;
  let res: { ok: boolean; message: string } | null = null;
  try { res = await adapter.fillApplication({} as ProjectRecord); } catch (e) { res = { ok: false, message: `threw ${String(e).slice(0, 200)}` }; }
  await page.waitForTimeout(300);
  const st = await state(page);
  const where = page.url();
  await ctx.close().catch(() => null);
  const filings = posts.filter((p) => /CapConfirm/i.test(p)).length;
  check("replay: 0 Enter presses, 0 filing requests", st.enters === 0 && filings === 0, `enters=${String(st.enters)} filings=${filings}`);
  check("MUST-PASS replay: THIS project's parcel, dashes removed, by the panel Search, and the replay reaches review",
    st.parcelSearched === "1122334400001.0000" && /CapConfirm/i.test(where), `parcelSearched=${String(st.parcelSearched)} at=${where} ok=${String(res?.ok)} ${String(res?.message).slice(0, 300)}`);
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} aca-work-location check(s) FAILED.`); process.exit(1); }
console.log("\nAll aca-work-location checks passed (real Chromium).");
process.exit(0);
