// A REPLAY THAT ENDS BEFORE THE REVIEW PAGE SAYS SO, AND NEVER CLICKS UNDER THE PORTAL'S LOADING
// MASK (runs-finish items 3 + 4, the parts that need no wizard-step reading), in real Chromium on
// Accela pages built from the CAPTURED Marion County services page (fixtures/marionServices/
// services.html, Oregon ePermitting, sanitized): its real step bar, page title, "Continue
// Application »" action bar and header/footer chrome; only the page's middle is swapped (the
// attachments step as live run 191e45c8's screenshot shows it, and the CapConfirm review page).
//
// Live run 191e45c8 (production ed44fc0, 2026-09-27, Accela / Oregon ePermitting): the attachment
// Save was clicked while Accela's "Please wait..." was up, the Continue after it landed nowhere, the
// replay ended on the attachments step, and the run was recorded awaiting_human_submit ("stopped at
// review") with 0 of 5 project values found on the page.
//
//   H  honest status, through the REAL runner (stageWithRecipe) and the REAL outcome
//      (repository.derivePortalRunOutcome):
//      MUST-PASS    a replay that ends on the attachments step is paused_for_human
//                   (stopped_before_review), names the page, never "stopped at review" /
//                   "staged ... to the review screen", 0 filing POSTs.
//      MUST-EXCLUDE a replay that ends ON CapConfirm is awaiting_human_submit, "stopped at review".
//   M  the loading mask and the upload's commit (RecipeAdapter directly, to read its notes):
//      MUST-PASS    the Save and the Continue wait for "Please wait..." to clear (0 clicks swallowed);
//                   the Save is confirmed by the attachment table listing the file; a page that
//                   comes up under the mask is waited out; a mask that never clears costs ONE
//                   bounded wait per run; an off-screen template is never a mask.
//      MUST-EXCLUDE a Save the portal never lists is named.
//   V  the advance check: a recorded advance whose click only HIDES the page's controls (a postback
//      mask over the same page) is not an advance — MUST-PASS it is reported "did not advance";
//      MUST-EXCLUDE a real advance to a page with no controls under the same heading still counts.
//
//   npx tsx portal-bot/src/adapters/replayHonestStop.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { PORTAL_SAFETY_IN_PAGE_SOURCE } from "../../../shared/src/portalSafety";
import { RecipeAdapter } from "./recipeAdapter";
import { stageWithRecipe } from "../index";
import { derivePortalRunOutcome, pausedRunSentence } from "../../../backend/src/repository";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";
process.env.PORTAL_HEADLESS = "true";

let failures = 0;
let passes = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { passes++; console.log(`  ok   - ${label}`); }
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// ---- fixtures built from the captured services page ------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVICES = fs.readFileSync(path.join(here, "fixtures", "marionServices", "services.html"), "utf8");
const TITLE_CAPTURED = "<td>Step 2</td><td>:</td><td>Services</td><td>&gt;</td><td>Service</td>";
const CONTENT_START = SERVICES.indexOf('<div ng-non-bindable="true">', SERVICES.indexOf("SecondAnchorInACAMainContent"));
const CONTENT_END = SERVICES.indexOf('<div class="actionbar_bottom">');
const PM = "ctl00_PlaceHolderMain_";
const FILE_ID = `${PM}attachmentEdit_fileUpload`;
const ATT_PATH = "/oregon/Cap/CapEdit.aspx?stepNumber=3&pageNumber=2&currentStep=1&currentPage=1&Module=Building";
const SVC2_PATH = "/oregon/Cap/CapEdit.aspx?stepNumber=3&pageNumber=3&currentStep=1&currentPage=2&Module=Building";
const CONFIRM_PATH = "/oregon/Cap/CapConfirm.aspx?stepNumber=4&pageNumber=1&currentStep=2&currentPage=0&Module=Building";
const PLAN_NAME = "Plan_Set_Fixture.pdf";

interface Scenario {
  /** How long the Save's "Please wait..." mask stays up. */
  maskMs: number;
  /** The Save lists the file in the attachment table afterwards. */
  list: boolean;
  /** Where the attachments step's Continue Application goes. */
  next: "confirm" | "services2" | "refuse";
  /** The step evidence on the attachments page. */
  evidence: "full" | "none" | "activeReview" | "manyActive" | "titleOnly";
  /** The page comes up under its "Please wait..." mask for this long (an async postback in flight). */
  maskOnLoadMs: number;
  /** The upload widget's file input is hidden behind its "Add" button (Accela's HTML5 uploader). */
  hiddenFileInput: boolean;
  /** A positioned "Loading..." box that never goes away, and a "Please wait..." template parked off-screen. */
  permanentMasks: boolean;
}
let sc: Scenario = { maskMs: 0, list: true, next: "confirm", evidence: "full", maskOnLoadMs: 0, hiddenFileInput: false, permanentMasks: false };
const counts = { advance: 0, filing: 0, save: 0, swallowed: 0 };
let saved: string[] = [];
let refuseNext = false;

/** The captured page with its middle replaced. `step`: which breadcrump step is selected (null = no
 *  step bar at all); `title`: the page-title cells (null = no page title). */
function accela(opts: { step: 2 | 3 | null; title: string[] | null; content: string; action: string; error?: string; manyActive?: boolean; maskOnLoadMs?: number }): string {
  let h = SERVICES.slice(0, CONTENT_START) + opts.content + SERVICES.slice(CONTENT_END);
  // The step bar first (its end is found by the page title that follows it), then the title.
  if (opts.step === null) h = h.replace(/<table role="presentation" class="breadcrump-table">[\s\S]*?(<div class="breadcrump-pagetitle)/, "$1");
  else if (opts.step === 3) h = h.replace('<td class="breadcrump-selected">', '<td class="breadcrump">').replace('<td class="breadcrump-disable">', '<td class="breadcrump-selected">');
  if (opts.title) h = h.replace(TITLE_CAPTURED, opts.title.map((c) => `<td>${c}</td>`).join(""));
  else h = h.replace(/<div class="breadcrump-pagetitle[^"]*">[\s\S]*?<\/div>/, "");
  if (opts.step === null && /breadcrump-selected|breadcrump-number/.test(h)) throw new Error("fixture: the step bar was not removed");
  if (opts.manyActive) h = h.replace(/<td class="breadcrump(-disable|-disable-end)?">/g, '<td class="breadcrump-selected">');
  h = h.replace(/(<form name="aspnetForm" method="post" action=")[^"]*(")/, `$1${opts.action.replace(/&/g, "&amp;")}$2`);
  if (opts.error) {
    h = h.replace('<div class="ACA_Content ACA_Hide">', '<div class="ACA_Content">')
      .replace('<span id="messageSpan" name="messageSpan"></span>', `<span id="messageSpan" name="messageSpan"><div id="messageSpan_messages"><div class="ACA_Message_Error ACA_Message_Error_FontSize"><table role="presentation"><tbody><tr><td class="ACA_Message_Content"><div id="messageSpanContent">An error has occurred.<br>${opts.error}<br></div></td></tr></tbody></table></div></div></span>`);
  }
  // The postback plumbing the capture stripped (scripts removed), and Accela's loading popup.
  const script = `<div id="__mask" class="ACA_Loading_Message" style="display:none;position:absolute;left:560px;top:420px;padding:14px 22px;background:#fff;border:1px solid #bbb"><span>Please wait...</span></div>
<script>(function(){
  var form = document.getElementById('aspnetForm');
  function hidden(n){ var i = form.querySelector('input[name="' + n + '"]'); if (!i) { i = document.createElement('input'); i.type = 'hidden'; i.name = n; form.appendChild(i); } return i; }
  window.__busy = false;
  window.__showMask = function(){ document.getElementById('__mask').style.display = 'block'; };
  window.__hideMask = function(){ document.getElementById('__mask').style.display = 'none'; };
  window.WebForm_PostBackOptions = function(t){ this.eventTarget = t; };
  window.WebForm_DoPostBackWithOptions = function(o){ if (window.__busy) return; hidden('__EVENTTARGET').value = o.eventTarget; form.submit(); };
  window.__doPostBack = function(t){ window.WebForm_DoPostBackWithOptions({ eventTarget: t }); };
  window.ProcessLoading = function(){ this.showLoading = function(){ window.__showMask(); }; };
  // A click under the mask lands nowhere (Accela's processing guard) — and is counted.
  window.Continue = function(){ if (window.__busy) { new Image().src = '/swallowed?' + Date.now(); return false; } return true; };
  window.WebForm_OnSubmit = function(){ return true; };
  window.SetNotAsk = function(){}; window.doSaveAndResume = function(){}; window.IsSaveButtonEnabled = function(){ return true; };
  if (${opts.maskOnLoadMs ?? 0} > 0) { window.__busy = true; window.__showMask(); setTimeout(function(){ window.__busy = false; window.__hideMask(); }, ${opts.maskOnLoadMs ?? 0}); }
})();</script>`;
  return h.replace("</body>", `${script}</body>`);
}

const ACTION_CONTINUE = "ctl00$PlaceHolderMain$actionBarBottom$btnContinue";

function attachmentsContent(): string {
  const rows = saved.length
    ? saved.map((n) => `<tr class="ACA_TabRow_Odd"><td>${n}</td><td>Plans - Electrical</td><td>16 B</td><td>09/27/2026</td><td><a href="javascript:void(0)">Actions</a></td></tr>`).join("")
    : `<tr><td colspan="5">No records found.</td></tr>`;
  return `<div class="ACA_TabRow"><span class="ACA_Required_Indicator">*</span>indicates a required field.</div>
<div ng-non-bindable="true" id="attachmentSection">
  <p>All documents uploaded for Electronic Document Review must, at a minimum, allow Printing and Markups to be considered reviewable.</p>
  <p>All similar Construction Documents must be uploaded in the same PDF. Not all agencies accept electronic plans.</p>
  ${sc.permanentMasks ? `<div class="ACA_Loading_Message" style="position:fixed;right:12px;bottom:12px;padding:6px">Loading...</div>
  <div class="ACA_Loading_Message" style="position:absolute;left:-9999px;top:0;padding:6px">Please wait...</div>` : ""}
  <div class="ACA_TabRow"><div class="ACA_Title_Bar"><h1>Attachment</h1></div></div>
  <p>The maximum file size allowed is 80 MB.</p>
  <table id="${PM}attachmentEdit_gdvAttachmentList" class="ACA_GridView"><tr><th>Name</th><th>Type</th><th>Size</th><th>Latest Update</th><th>Action</th></tr>${rows}</table>
  <div id="uploadWidget">
    <input type="file" id="${FILE_ID}" name="${FILE_ID.replace(/_/g, "$")}" accept=".pdf" style="${sc.hiddenFileInput ? "display:none" : "width:90px"}">
    <div id="pending" style="display:none">
      <label for="${PM}attachmentEdit_txtDescription">*Description:</label> <textarea id="${PM}attachmentEdit_txtDescription" rows="4" cols="60"></textarea>
      <label for="${PM}attachmentEdit_ddlType">*Type (Required):</label> <select id="${PM}attachmentEdit_ddlType"><option value="">--Select--</option><option>Plans - Construction</option><option>Plans - Electrical</option><option>Site Plan</option></select>
      <div>File: <span id="fname"></span> <span class="progress">100%</span></div>
    </div>
    <a id="${PM}attachmentEdit_btnSave" class="ACA_SmButton" href="javascript:void(0)" onclick="saveAttachment();return false;">Save</a>
    <label for="${FILE_ID}" id="${PM}attachmentEdit_btnAdd" class="ACA_SmButton">Add</label>
    <a id="${PM}attachmentEdit_btnRemoveAll" class="ACA_SmButton" href="javascript:void(0)" onclick="return false;">Remove All</a>
  </div>
  <script>(function(){
    var fi = document.getElementById('${FILE_ID}');
    fi.addEventListener('change', function(){ if (fi.files && fi.files[0]) { document.getElementById('pending').style.display = 'block'; document.getElementById('fname').textContent = fi.files[0].name; } });
    window.saveAttachment = function(){
      if (window.__busy) { new Image().src = '/swallowed?' + Date.now(); return; }
      var name = fi.files && fi.files[0] ? fi.files[0].name : '';
      window.__busy = true; window.__showMask();
      fetch('/save', { method: 'POST', body: name });
      setTimeout(function(){
        window.__busy = false; window.__hideMask();
        if (name && ${sc.list ? "true" : "false"}) {
          var t = document.getElementById('${PM}attachmentEdit_gdvAttachmentList');
          var none = Array.from(t.querySelectorAll('td[colspan]')); none.forEach(function(td){ td.parentElement.remove(); });
          var tr = document.createElement('tr'); tr.className = 'ACA_TabRow_Odd';
          tr.innerHTML = '<td>' + name + '</td><td>Plans - Electrical</td><td>16 B</td><td>09/27/2026</td><td><a href="javascript:void(0)">Actions</a></td>';
          t.appendChild(tr);
        }
        document.getElementById('pending').style.display = 'none'; fi.value = '';
      }, ${sc.maskMs});
    };
  })();</script>
</div>`;
}

const attachmentsPage = (error?: string): string => accela({
  step: sc.evidence === "none" || sc.evidence === "titleOnly" ? null : sc.evidence === "activeReview" ? 3 : 2,
  title: sc.evidence === "full" || sc.evidence === "manyActive" || sc.evidence === "titleOnly" ? ["Step 2", ":", "Services", "&gt;", "Attachments"] : null,
  content: attachmentsContent(), action: ATT_PATH, error, manyActive: sc.evidence === "manyActive", maskOnLoadMs: sc.maskOnLoadMs,
});
const services2Page = (): string => accela({
  step: 2, title: ["Step 2", ":", "Services", "&gt;", "Additional Info"], action: SVC2_PATH,
  content: `<div ng-non-bindable="true"><div class="ACA_TabRow"><div class="ACA_Title_Bar"><h1>Additional Info</h1></div></div><p>No additional information is required for this record type.</p></div>`,
});
const confirmPage = (): string => accela({
  step: 3, title: ["Step 3", ":", "Review"], action: CONFIRM_PATH,
  content: `<div ng-non-bindable="true" class="ACA_Area_CapConfirm">
  <p>Please review all information below. Click the "Edit" buttons to make changes to sections or "Continue Application" to move on.</p>
  <div class="ACA_TabRow"><div class="ACA_Title_Bar"><h1>Work Location</h1></div></div><p>1 FIXTURE WAY, FERNHOLLOW OR 97000</p>
  <div class="ACA_TabRow"><div class="ACA_Title_Bar"><h1>Attachments</h1></div></div>
  <table class="ACA_GridView"><tr><th>Name</th><th>Type</th></tr>${saved.map((n) => `<tr><td>${n}</td><td>Plans - Electrical</td></tr>`).join("") || "<tr><td colspan=2>No records found.</td></tr>"}</table>
  <label for="${PM}attachmentEdit_fileUploadConfirm">Add attachment:</label> <input type="file" id="${PM}attachmentEdit_fileUploadConfirm">
</div>`,
});


/** V: a same-heading SPA page whose Next hides every control (a postback mask) and then either
 *  brings the SAME page back (`back`), or shows a real next section with no controls (`stay`). */
const vanishPage = (mode: "back" | "stay"): string => `<!doctype html><html><head><title>Permit application</title></head><body>
<h1>Permit application</h1>
<div id="form"><label for="a">Owner name</label> <input id="a" name="a"><label for="b">Owner phone</label> <input id="b" name="b"></div>
<div id="done" style="display:none"><p>Section complete. Your answers were saved.</p></div>
<button id="next" type="button">Next</button>
<script>
document.getElementById('next').addEventListener('click', function () {
  new Image().src = '/vanish-click?' + Date.now();
  setTimeout(function () { document.getElementById('form').style.display = 'none'; }, 150);
  ${mode === "back"
    ? "setTimeout(function () { document.getElementById('form').style.display = 'block'; }, 1650);"
    : "setTimeout(function () { document.getElementById('done').style.display = 'block'; document.getElementById('next').remove(); }, 200);"}
});
</script></body></html>`;
let vanishClicks = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const send = (html: string, code = 200): void => { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
  if (url.pathname === "/swallowed") { counts.swallowed++; res.writeHead(204); res.end(); return; }
  if (url.pathname === "/vanish-click") { vanishClicks++; res.writeHead(204); res.end(); return; }
  if (url.pathname === "/vanish-back") { send(vanishPage("back")); return; }
  if (url.pathname === "/vanish-stay") { send(vanishPage("stay")); return; }
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (url.pathname === "/save") { counts.save++; if (body && sc.list) saved.push(body); res.writeHead(200); res.end("ok"); return; }
      const target = new URLSearchParams(body).get("__EVENTTARGET") || "";
      const isContinue = target === ACTION_CONTINUE;
      if (/CapConfirm/i.test(url.pathname) && isContinue) {
        counts.filing++; // THE FILING (Accela's CapConfirm Continue Application)
        send("<!doctype html><html><body><h1>Step 5 : Record Issuance</h1><p>Your application has been successfully submitted.</p></body></html>");
        return;
      }
      if (isContinue && /pageNumber=2/.test(url.search)) {
        counts.advance++;
        if (sc.next === "refuse" || refuseNext) { send(attachmentsPage("Please save the attachment before continuing.")); return; }
        res.writeHead(302, { location: sc.next === "services2" ? SVC2_PATH : CONFIRM_PATH }); res.end(); return;
      }
      if (isContinue && /pageNumber=3/.test(url.search)) { counts.advance++; res.writeHead(302, { location: CONFIRM_PATH }); res.end(); return; }
      send(attachmentsPage());
    });
    return;
  }
  if (/CapConfirm/i.test(url.pathname)) { send(confirmPage()); return; }
  if (/pageNumber=3/.test(url.search)) { send(services2Page()); return; }
  if (/CapEdit/i.test(url.pathname)) { send(attachmentsPage()); return; }
  send("<!doctype html><html><body>not found</body></html>", 404);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();
const newPage = async (): Promise<Page> => {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  // The captured chrome references live portal assets: never fetch them.
  await ctx.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.fallback() : route.abort()));
  return ctx.newPage();
};
const reset = (s: Partial<Scenario>): void => {
  sc = { maskMs: 0, list: true, next: "confirm", evidence: "full", maskOnLoadMs: 0, hiddenFileInput: false, permanentMasks: false, ...s };
  counts.advance = 0; counts.filing = 0; counts.save = 0; counts.swallowed = 0;
  saved = [];
  refuseNext = false;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "replay-honest-stop-"));
const pdf = path.join(tmp, PLAN_NAME);
fs.writeFileSync(pdf, "%PDF-1.4\n%%EOF\n");
const CONTINUE_CSS = `#${PM}actionBarBottom_btnContinue`;
const UPLOAD: RecipeStep = { action: "upload", selector: { css: '[data-al-upl="f0"]' }, docType: "plan_set", viaFileChooser: false, note: "upload plan_set: Add" };
const DESC: RecipeStep = { action: "fill", selector: { css: "textarea" }, value: "Solar PV plan set — electrical plans and specifications", note: "attachment: description" };
const TYPE: RecipeStep = { action: "select", selector: { css: "select" }, value: "Plans - Electrical", note: "attachment: document type" };
const SAVE: RecipeStep = { action: "click", selector: { role: "link", name: "Save", exact: true, fallbacks: [{ css: "a[id*='attachmentEdit_btnSave' i]" }] }, note: "attachment: save (commits the upload)" };
const CONT_SEL = { role: "link", name: "Continue Application »", exact: true, fallbacks: [{ css: CONTINUE_CSS }] };
const ADVANCE: RecipeStep = { action: "click", selector: CONT_SEL, note: "advance: Continue Application »" };
const FINAL: RecipeStep = { action: "click", selector: CONT_SEL, isFinalSubmit: true, note: "final submit: Continue Application » (recorded, NOT clicked)" };
const recipeOf = (steps: RecipeStep[], entry = `${base}${ATT_PATH}`): PortalRecipe => ({
  id: "replay-honest-stop-smoke", scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "accela", portalUrl: entry, status: "complete", version: 1,
  steps, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
});
const msgOf = (r: Record<string, unknown>): string => {
  const steps = Array.isArray(r.steps) ? (r.steps as Array<{ message?: unknown }>) : [];
  return [String(r.message ?? ""), ...steps.map((s) => String(s?.message ?? ""))].filter(Boolean).join(" | ");
};

/** Through the REAL runner: login -> open -> fill (replay) -> upload -> stopAtReview. */
async function staged(name: string, steps: RecipeStep[], entry?: string) {
  const r = await stageWithRecipe(recipeOf(steps, entry), { id: `p-${name}` } as ProjectRecord, {}, { plan_set: pdf }, [], { headless: true });
  const outcome = derivePortalRunOutcome(r);
  const msg = msgOf(r);
  console.log(`  [${name}] ok=${String(r.ok)} pause=${String(r.pauseReason ?? "-")} status=${outcome.status} advance=${counts.advance} filing=${counts.filing}\n         ${msg.slice(0, 300)}`);
  return { r, outcome, msg };
}

/** RecipeAdapter directly, to read its notes. */
async function replay(name: string, steps: RecipeStep[], entry?: string) {
  const page = await newPage();
  const adapter = new RecipeAdapter(recipeOf(steps, entry), {}, { plan_set: pdf });
  (adapter as unknown as { page: unknown }).page = page;
  const t0 = Date.now();
  const result = await adapter.fillApplication({} as ProjectRecord);
  const url = page.url();
  await page.context().close();
  const data = (result.data ?? {}) as { driftWarnings?: string[]; agingNotes?: string[]; slowSteps?: Array<{ note: string; phases?: Record<string, number> }> };
  const msg = String(result.message ?? "");
  const out = { result, data, msg, pause: String((result as { pauseReason?: unknown }).pauseReason ?? ""), url, ms: Date.now() - t0,
    drift: (data.driftWarnings ?? []).join(" | "), aging: (data.agingNotes ?? []).join(" | "), ...counts };
  console.log(`  [${name}] ok=${result.ok} pause=${out.pause || "-"} advance=${counts.advance} filing=${counts.filing} save=${counts.save} swallowed=${counts.swallowed} at=${url.replace(base, "")} ${out.ms} ms\n         ${msg.slice(0, 260)}`);
  return out;
}

console.log("\nH. honest status — through the real runner and the real outcome");
{
  // What the shared reading says about the two pages (printed: the verdicts below depend on it).
  reset({});
  const p = await newPage();
  for (const [label, u] of [["attachments", `${base}${ATT_PATH}`], ["CapConfirm", `${base}${CONFIRM_PATH}`]] as const) {
    await p.goto(u, { waitUntil: "domcontentloaded" });
    await p.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = await p.evaluate(() => (globalThis as any).__portalSafety.terminalPageInPage());
    console.log(`     ${label}: reviewPage=${t.reviewPage} readOnlyPage=${t.readOnlyPage} terminal=${t.terminal}`);
  }
  await p.context().close();
}
{
  reset({});
  const o = await staged("ends on attachments", [{ action: "goto", value: `${base}${ATT_PATH}`, note: "entry url" }, UPLOAD, DESC, TYPE, SAVE, FINAL]);
  check("MUST-PASS a replay that ends on the attachments step is paused_for_human (stopped_before_review), never awaiting_human_submit",
    o.outcome.status === "paused_for_human" && o.outcome.pauseReason === "stopped_before_review", `status=${o.outcome.status} pause=${o.outcome.pauseReason}`);
  check("MUST-PASS it names the page and says it is NOT the review page; never 'stopped at review' / 'staged ... to the review screen'",
    /STOPPED on "Step 2: Services > Attachments" — NOT the review page/.test(o.msg) &&!/stopped at review/.test(o.msg) && !/staged .* to the review screen/.test(o.msg), o.msg.slice(0, 400));
  check("MUST-PASS the operator's sentence is the stop's own words, not 'a ... challenge — nothing was staged'",
    /^stopped before review — .*STOPPED on "/.test(pausedRunSentence("stopped_before_review", o.r)) && !/challenge/.test(pausedRunSentence("stopped_before_review", o.r)),
    pausedRunSentence("stopped_before_review", o.r).slice(0, 300));
  check("0 filing POSTs", counts.filing === 0, `filing=${counts.filing}`);
}
{
  reset({});
  saved = [PLAN_NAME];
  const o = await staged("ends ON CapConfirm", [{ action: "goto", value: `${base}${CONFIRM_PATH}`, note: "entry url" }, FINAL], `${base}${CONFIRM_PATH}`);
  check("MUST-EXCLUDE a replay that ends on CapConfirm is awaiting_human_submit, 'stopped at review', staged to the review screen",
    o.outcome.status === "awaiting_human_submit" && /stopped at review/.test(o.msg) && /staged .* to the review screen/.test(o.msg) && !o.outcome.pauseReason,
    `status=${o.outcome.status} ${o.msg.slice(0, 300)}`);
  check("0 filing POSTs", counts.filing === 0, `filing=${counts.filing}`);
}

console.log("\nM. the loading mask and the upload's commit");
{
  reset({ maskMs: 2500 });
  const o = await replay("Save under a 2.5 s 'Please wait...'", [{ action: "goto", value: `${base}${ATT_PATH}`, note: "entry url" }, UPLOAD, DESC, TYPE, SAVE, ADVANCE, FINAL]);
  check("MUST-PASS no click is swallowed under the mask", o.swallowed === 0, `swallowed=${o.swallowed}`);
  check("MUST-PASS the Save is confirmed by the attachment list, the wait is named", /listed "Plan_Set_Fixture\.pdf" .* the upload committed|waited .*loading mask/.test(o.aging), o.aging.slice(0, 400));
  check("MUST-PASS the recorded advance reaches the review page: one advance, 'stopped at review', 0 filing POSTs", o.advance === 1 && /CapConfirm/i.test(o.url) && o.filing === 0 && /stopped at review/.test(o.msg), `advance=${o.advance} filing=${o.filing} at=${o.url}`);
}
{
  reset({ maskOnLoadMs: 5000 });
  const o = await replay("the page comes up under a 5 s 'Please wait...'", [{ action: "goto", value: `${base}${ATT_PATH}`, note: "entry url" }, ADVANCE, FINAL]);
  check("MUST-PASS the advance waits the mask out: no click swallowed, one advance to the review page", o.swallowed === 0 && o.advance === 1 && /CapConfirm/i.test(o.url), `swallowed=${o.swallowed} advance=${o.advance} at=${o.url}`);
  check("MUST-PASS the wait is named (agingNotes), and its phase is timed (slowSteps overlay-wait)",
    /waited .*s for the portal's loading mask "Please wait/.test(o.aging) && (o.data.slowSteps ?? []).some((s) => (s.phases?.["overlay-wait"] ?? 0) > 0), `${o.aging.slice(0, 300)} slow=${JSON.stringify(o.data.slowSteps ?? []).slice(0, 300)}`);
}
{
  reset({ permanentMasks: true });
  const REMOVE_ALL: RecipeStep = { action: "click", selector: { role: "link", name: "Remove All", exact: true }, note: "attachment: remove all" };
  const saved0 = RecipeAdapter.LOADING_MASK_WAIT_MS;
  RecipeAdapter.LOADING_MASK_WAIT_MS = 2000;
  const o = await replay("a permanent 'Loading...' box and an off-screen template", [{ action: "goto", value: `${base}${ATT_PATH}`, note: "entry url" }, REMOVE_ALL, ADVANCE, FINAL]);
  RecipeAdapter.LOADING_MASK_WAIT_MS = saved0;
  const stuck = (o.data.driftWarnings ?? []).filter((w) => /loading mask .* was still up/.test(w));
  const advanceWait = (o.data.slowSteps ?? []).find((s) => /^advance/.test(s.note))?.phases?.["overlay-wait"] ?? 0;
  check("MUST-EXCLUDE a mask that never clears is waited on ONCE (the first click), named, and never again",
    stuck.length === 1 && /"Loading\.\.\."/.test(stuck[0]) && advanceWait < 1000, `stuck=${JSON.stringify(stuck)} advance overlay-wait=${advanceWait} ms`);
  check("MUST-EXCLUDE an off-screen 'Please wait...' template is never a mask", !/Please wait/.test(o.drift + o.aging), (o.drift + " | " + o.aging).slice(0, 300));
  check("...and the run still advances once to the review page, 0 filing POSTs", o.advance === 1 && /CapConfirm/i.test(o.url) && o.filing === 0, `advance=${o.advance} filing=${o.filing} at=${o.url}`);
}
{
  reset({ maskMs: 800, list: false, next: "refuse" });
  const o = await replay("the portal never lists the saved file", [{ action: "goto", value: `${base}${ATT_PATH}`, note: "entry url" }, UPLOAD, DESC, TYPE, SAVE, FINAL]);
  check("MUST-EXCLUDE a Save the portal never lists is named", /attachment list does not show "Plan_Set_Fixture\.pdf"/.test(o.drift), o.drift.slice(0, 400));
}

console.log("\nV. the advance check — controls that merely vanished are not an advance");
{
  const saved0 = RecipeAdapter.VANISHED_CONTROLS_WAIT_MS;
  RecipeAdapter.VANISHED_CONTROLS_WAIT_MS = 3000;
  const NEXT: RecipeStep = { action: "click", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: "#next" }] }, note: "advance: Next" };
  vanishClicks = 0;
  reset({});
  const back = await replay("Next hides the form, then the SAME page comes back", [{ action: "goto", value: `${base}/vanish-back`, note: "entry url" }, NEXT, { action: "stopForReview" }], `${base}/vanish-back`);
  check("MUST-PASS a click that only hid the controls is NOT an advance: the run reports the portal did not advance",
    back.result.ok === false && /did not advance/.test(back.msg), `ok=${back.result.ok} clicks=${vanishClicks} ${back.msg.slice(0, 300)}`);
  vanishClicks = 0;
  reset({});
  const stay = await replay("Next shows a real next section with no controls (same heading)", [{ action: "goto", value: `${base}/vanish-stay`, note: "entry url" }, NEXT, { action: "stopForReview" }], `${base}/vanish-stay`);
  check("MUST-EXCLUDE a real advance to a page with no controls still counts (no false stop), after one bounded wait",
    stay.result.ok === true && !/did not advance/.test(stay.msg) && vanishClicks === 1, `ok=${stay.result.ok} clicks=${vanishClicks} ${stay.msg.slice(0, 300)}`);
  RecipeAdapter.VANISHED_CONTROLS_WAIT_MS = saved0;
}

await browser.close();
server.close();
console.log(`\nreplayHonestStop: ${passes} passed, ${failures} failed (of ${passes + failures} checks)`);
if (failures) { console.error(`replayHonestStop: ${failures} check(s) FAILED`); process.exit(1); }
console.log("replayHonestStop: all checks passed (real Chromium, captured Accela chrome)");
