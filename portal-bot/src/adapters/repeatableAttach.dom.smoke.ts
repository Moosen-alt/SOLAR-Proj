// EVERY OWED DOCUMENT GOES UP, ONE ROW EACH, TYPED BY THE DOCUMENT (docs plan D7 + D4 ledger), in real
// Chromium on the CAPTURED Marion County page chrome (fixtures/marionServices/services.html, Oregon
// ePermitting) with the attachments step as live run 191e45c8 showed it: Add → a pending row (Description +
// Type) → Save → the attachment table. The Type select carries Oregon ePermitting's REAL option list
// (data/portal-replicas/city-of-coos-bay.json, verbatim), which has no "Application" or "Checklist" option.
//
//   MUST-PASS    building: the recorded plan-set row, then the B-01S and the 5952 — 3 rows: plan set
//                "Plans - Structural", B-01S "Other", 5952 "Other" (operator OD-2); each named as what it
//                is, never "tmpl-<uuid>.pdf"; the ledger says attached; one advance; 0 filing POSTs.
//   MUST-PASS    electrical: plan set + the E-01 ("Other") — operator OD-8.
//   MUST-EXCLUDE no Type fits (a list with no "Other"): that document is NOT uploaded, named NOT ATTACHED;
//                the approved final submit refuses while it is owed.
//   MUST-EXCLUDE a document the portal already lists is not uploaded twice.
//   MUST-EXCLUDE "Homeowner Acknowledgement" / "Contractor Responsibility Form" chosen for any row.
//   MUST-EXCLUDE no owed list: exactly today's single row.
//
// NUMBERED TYPES (City of Corvallis, live 2026-09-28, learn run 16-40-15 p017): the Type offers "01 Plans" /
// "02 Specifications or Engineering" / "03 Other Documents", each option's VALUE "ACA USERS - DS BLD RES::<text>",
// and choosing one fires Accela's loading mask. The learner missed the numbering, never chose a Type, the Save
// was refused and a person picked the Type by hand — so that recipe has NO Type step.
//   MUST-PASS    the LEARNER's pass types the plan set's row "01 Plans" and records the stamped Type step;
//                on Oregon ePermitting it still picks "Plans - Structural" / "Plans - Electrical".
//   MUST-PASS    replay with the recorded Type step: plan set "01 Plans", an owed B-01S "03 Other Documents",
//                an owed module spec "02 Specifications or Engineering".
//   MUST-PASS    replay of a recipe with NO Type step (and no Description step — what p016 recorded): the
//                plan set's row still saves ("01 Plans", chosen by the document), and the owed rows too.
//   MUST-EXCLUDE never a Save clicked under the Type's loading mask.
//
//   npx tsx portal-bot/src/adapters/repeatableAttach.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import { attachmentTypeFor } from "./attachmentTypes";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";

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

// Oregon ePermitting's attachment Type list, verbatim (data/portal-replicas/city-of-coos-bay.json, CapEdit step 3 page 2).
const TYPES_REAL = ["--Select--", "Contractor Responsibility Form", "Deferred Submittal Agreement", "Flood Plain Elevation Certificate", "Framing Moisture Content Statement",
  "Homeowner Acknowledgement", "Lighting Efficiency Statement", "Other", "Plans - Architectural", "Plans - Civil", "Plans - Construction", "Plans - Electrical",
  "Plans - Fire Alarm", "Plans - Fire Sprinkler", "Plans - Mechanical", "Plans - Plumbing", "Plans - Site Plan", "Plans - Structural", "Plans - Truss", "Revisions",
  "Septic Review", "Special Inspection Deficiencies Report", "Special Inspection Final Summary Report", "Special Inspection Form", "Specifications", "Structural Calculations"];
// City of Corvallis's Type list, verbatim (learn run 2026-09-28_16-40-15, page-p017 ddlDocType).
const TYPES_CORVALLIS = ["--Select--", "01 Plans", "02 Specifications or Engineering", "03 Other Documents"];
let types = TYPES_REAL;
/** Corvallis: each option's VALUE is "<prefix><text>" ("ACA USERS - DS BLD RES::01 Plans"); "" = value is the text. */
let typeValuePrefix = "";
/** Corvallis: choosing a Type fires ProcessLoading (the mask) for this long; a Save under it is swallowed. 0 = none. */
let typeMaskMs = 0;
let rows: Array<{ name: string; type: string; desc: string; value?: string }> = [];
/** Real Accela (live run 090fa574): the pending row — Description + Type — is BUILT when a file is
 *  added and removed on Save; before Save it shows "File: <name>". false = a static row (older shape). */
let rowAfterUpload = true;
/** Real Accela redraws its saved list a while after the "successfully uploaded" banner. */
let listDelayMs = 0;
/** The portal refuses the Save of a file whose name contains this (a validation error; nothing posts). */
let failSaveFor = "";
/** A SILENT refusal (skeptic 13985c6 S1/S3): the Save posts an attempt the server ignores, no error, no
 *  reload — the pending row (with "File: <name>") stays. resetTypeOnRefuse: the row's Type resets. */
let silentRefuseFor = "";
let resetTypeOnRefuse = false;
const saveAttempts: string[] = [];
/** A file name printed inside the page's instructions (S7b). */
let instructionsName = "";
const formSaves: string[] = [];
const counts = { advance: 0, filing: 0, save: 0, swallowed: 0 };
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function attachmentsContent(): string {
  const body = rows.length
    ? rows.map((r) => `<tr class="ACA_TabRow_Odd"><td>${esc(r.name)}</td><td>${esc(r.type)}</td><td>16 B</td><td>09/27/2026</td><td><a href="javascript:void(0)">Actions</a></td></tr>`).join("")
    : `<tr><td colspan="5">No records found.</td></tr>`;
  const options = types.map((t) => `<option value="${t === "--Select--" ? "" : esc(typeValuePrefix + t)}">${esc(t)}</option>`).join("");
  // Corvallis: the Type's onchange is Accela's ProcessLoading + a postback — the mask, for typeMaskMs.
  const onType = typeMaskMs > 0 ? ` onchange="window.__busy=true;window.__showMask();setTimeout(function(){window.__busy=false;window.__hideMask();},${typeMaskMs})"` : "";
  // The pending row as Accela builds it (dlDocumentEdit): Description, Type, then "File: <name>" 100%.
  const rowHtml = `<div id="pendingRow"><label for="${PM}dlDocumentEdit_ctl00_txtDescription">*Description:</label> <textarea id="${PM}dlDocumentEdit_ctl00_txtDescription" rows="4" cols="60"></textarea>
      <label for="${PM}dlDocumentEdit_ctl00_ddlDocType">*Type (Required):</label> <select id="${PM}dlDocumentEdit_ctl00_ddlDocType"${onType}>${options}</select>
      <table style="display:none;"><tr><td><label for="${PM}dlDocumentEdit_ctl00_ddlAlsoAttachTo">Also attach to:</label> <select id="${PM}dlDocumentEdit_ctl00_ddlAlsoAttachTo"><option value="">--Select--</option></select></td></tr></table>
      <div>File: <span id="fname"></span> <span class="progress">100%</span></div></div>`;
  return `<div ng-non-bindable="true" id="attachmentSection">
  ${rows.length ? `<div class="ACA_Message_Notice">The attachment(s) has/have been successfully uploaded. It may take a few minutes before changes are reflected.</div>` : ""}
  <div class="ACA_TabRow"><div class="ACA_Title_Bar"><h1>Attachment</h1></div></div>
  <p>The maximum file size allowed is 80 MB.</p>${instructionsName ? `<p>Example of a well-named file: ${esc(instructionsName)}</p>` : ""}
  <iframe id="${PM}attachmentEdit_iframeAttachmentList" src="/FileUpload/AttachmentsList.aspx?d=${listDelayMs}" style="width:100%;height:140px;border:0"></iframe>
  <div id="uploadWidget">
    <input type="file" id="${FILE_ID}" name="${FILE_ID.replace(/_/g, "$")}" accept=".pdf" style="width:90px">
    <div id="pending">${rowAfterUpload ? "" : rowHtml}</div>
    <a id="${PM}attachmentEdit_btnSave" class="ACA_SmButton" href="javascript:void(0)" onclick="saveAttachment();return false;">Save</a>
    <label for="${FILE_ID}" id="${PM}attachmentEdit_btnAdd" class="ACA_SmButton">Add</label>
  </div>
  <script>(function(){
    var fi = document.getElementById('${FILE_ID}');
    var ROW = ${JSON.stringify(rowHtml)};
    fi.addEventListener('change', function(){
      if (!(fi.files && fi.files[0])) return;
      if (!document.getElementById('pendingRow')) document.getElementById('pending').innerHTML = ROW;
      document.getElementById('fname').textContent = fi.files[0].name;
    });
    window.saveAttachment = function(){
      // Under Accela's processing mask a click lands nowhere — and is counted.
      if (window.__busy) { new Image().src = '/swallowed?' + Date.now(); return; }
      var name = fi.files && fi.files[0] ? fi.files[0].name : '';
      var dd = document.querySelector('#pendingRow select'); var ta = document.querySelector('#pendingRow textarea');
      // The row's Type as the portal SHOWS it (the option text; Corvallis's value carries a code prefix).
      var tt = dd && dd.value && dd.selectedIndex >= 0 ? dd.options[dd.selectedIndex].text : '';
      if (${JSON.stringify(silentRefuseFor)} && name.indexOf(${JSON.stringify(silentRefuseFor)}) >= 0) { fetch('/saveattempt', { method: 'POST', body: JSON.stringify({ name: name, type: tt, desc: ta ? ta.value : '' }) }); if (${resetTypeOnRefuse} && dd) dd.value = ''; return; }
      if (!name || !dd || !dd.value || (${JSON.stringify(failSaveFor)} && name.indexOf(${JSON.stringify(failSaveFor)}) >= 0)) { var e = document.getElementById('err') || document.createElement('div'); e.id = 'err'; e.className = 'ACA_Message_Error'; e.textContent = 'Type (Required): please select a value.'; document.getElementById('uploadWidget').appendChild(e); return; }
      fetch('/save', { method: 'POST', body: JSON.stringify({ name: name, type: tt, value: dd.value, desc: ta ? ta.value : '' }) }).then(function(){ location.reload(); });
    };
  })();</script>
</div>`;
}
const attachmentsPage = (): string => accela({ step: 2, title: ["Step 2", ":", "Services", "&gt;", "Attachments"], content: attachmentsContent(), action: ATT_PATH });
const confirmPage = (): string => accela({
  step: 3, title: ["Step 3", ":", "Review"], action: CONFIRM_PATH,
  content: `<div ng-non-bindable="true" class="ACA_Area_CapConfirm"><p>Please review all information below.</p>
  <div class="ACA_TabRow"><div class="ACA_Title_Bar"><h1>Attachments</h1></div></div>
  <table class="ACA_GridView"><tr><th>Name</th><th>Type</th></tr>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.type)}</td></tr>`).join("")}</table></div>`,
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const send = (html: string): void => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (url.pathname === "/formsave") { formSaves.push(body); res.writeHead(200); res.end("ok"); return; }
      if (url.pathname === "/saveattempt") { saveAttempts.push(body); res.writeHead(200); res.end("ok"); return; }
      if (url.pathname === "/save") { counts.save++; try { rows.push(JSON.parse(body)); } catch { /* malformed */ } res.writeHead(200); res.end("ok"); return; }
      const target = new URLSearchParams(body).get("__EVENTTARGET") || "";
      if (/CapConfirm/i.test(url.pathname) && target === ACTION_CONTINUE) { counts.filing++; send("<!doctype html><html><body><h1>Record Issuance</h1><p>Your application has been successfully submitted.</p></body></html>"); return; }
      if (target === ACTION_CONTINUE && /pageNumber=2/.test(url.search)) { counts.advance++; res.writeHead(302, { location: CONFIRM_PATH }); res.end(); return; }
      send(attachmentsPage());
    });
    return;
  }
  if (url.pathname === "/FileUpload/AttachmentsList.aspx") {
    const d = Number(url.searchParams.get("d") || 0);
    const body = rows.length ? rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.type)}</td><td>16 B</td></tr>`).join("") : `<tr><td colspan="3">No records found.</td></tr>`;
    send(`<!doctype html><html><body><table><thead><tr><th>Name</th><th>Type</th><th>Size</th></tr></thead><tbody id="r">${d > 0 ? "<tr><td>Loading...</td></tr>" : body}</tbody></table>${d > 0 ? `<script>setTimeout(function(){document.getElementById('r').innerHTML=${JSON.stringify(body)};},${d});</script>` : ""}</body></html>`);
    return;
  }
  if (url.pathname === "/form") {
    send(`<!doctype html><html><body><h1>Project Details</h1>
      <label for="ps">Plan Set</label> <input type="file" id="ps" accept=".pdf">
      <label for="dw">Description of Work</label> <textarea id="dw"></textarea>
      <label for="wt">Work Type</label> <select id="wt"><option value="">--Select--</option><option>New</option><option>Alteration</option><option>Other</option></select>
      <button type="button" id="sv" onclick="var f=document.getElementById('ps').files;fetch('/formsave',{method:'POST',body:JSON.stringify({desc:document.getElementById('dw').value,workType:document.getElementById('wt').value,planFile:f&&f[0]?f[0].name:''})});">Save</button>
      <a id="next" href="/CapConfirm.aspx">Continue Application »</a></body></html>`);
    return;
  }
  if (url.pathname === "/swallowed") { counts.swallowed++; res.writeHead(204); res.end(); return; }
  if (/CapConfirm/i.test(url.pathname)) { send(confirmPage()); return; }
  if (/CapEdit/i.test(url.pathname)) { send(attachmentsPage()); return; }
  res.writeHead(404); res.end("not found");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch();
const newPage = async (): Promise<Page> => {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  await ctx.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.fallback() : route.abort()));
  return ctx.newPage();
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repeatable-attach-"));
const pdfAt = (name: string): string => { const p = path.join(tmp, name); fs.writeFileSync(p, "%PDF-1.4\n%%EOF\n"); return p; };
const DOCS = {
  plan_set: pdfAt(PLAN_NAME),
  building_application: pdfAt("tmpl-0d26f7e9-0126-4d9c-b238-f03b593cf02c.pdf"),
  solar_checklist: pdfAt("tmpl-637814c9-6c4b-4bdd-938d-4ac748a284fa.pdf"),
  electrical_application: pdfAt("tmpl-820f1e53-91b0-4480-ba3b-d1b18e417144.pdf"),
  module_spec: pdfAt("tmpl-5b0c1f7e-2a44-4c1e-9d0a-7f3e2c9b1a55.pdf"),
};
const SPEC = "REC Alpha Pure-R module specification sheet";
const CV_PREFIX = "ACA USERS - DS BLD RES::";
const B01S = "Marion County Prescriptive Solar Photovoltaic Installation Permit Application (B-01S)";
const C5952 = "Oregon BCD 440-5952 prescriptive rooftop PV checklist";
const E01 = "Marion County Renewable Electrical Energy Permit Application (E-01)";
const CONTINUE_CSS = `#${PM}actionBarBottom_btnContinue`;
const CONT_SEL = { role: "link", name: "Continue Application »", exact: true, fallbacks: [{ css: CONTINUE_CSS }] };
const recipeSteps = (planType: string): RecipeStep[] => [
  { action: "goto", value: `${base}${ATT_PATH}`, note: "entry url" },
  { action: "upload", selector: { css: '[data-al-upl="f0"]' }, docType: "plan_set", viaFileChooser: false, note: "upload plan_set: Add" },
  { action: "fill", selector: { css: "textarea" }, value: "Solar PV plan set", note: "attachment: description" },
  { action: "select", selector: { css: "select" }, value: planType, note: "attachment: document type" },
  { action: "click", selector: { role: "link", name: "Save", exact: true, fallbacks: [{ css: "a[id*='attachmentEdit_btnSave' i]" }] }, note: "attachment: save (commits the upload)" },
  { action: "click", selector: CONT_SEL, note: "advance: Continue Application »" },
  { action: "click", selector: CONT_SEL, isFinalSubmit: true, note: "final submit: Continue Application » (recorded, NOT clicked)" },
];
const recipeOf = (steps: RecipeStep[]): PortalRecipe => ({
  id: "repeatable-attach-smoke", scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "accela", portalUrl: `${base}${ATT_PATH}`, status: "complete", version: 1, steps, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
});
/** A recording with NO Type step and no Description step — what the Corvallis learn recorded on p016
 *  (attachment_save: descFilled 0, typeSet 0): the upload, then the stamped Save. */
const untypedSteps = (): RecipeStep[] => recipeSteps("").filter((s) => !/^attachment:\s*(description|document type)\b/i.test(String(s.note ?? "")));
async function replay(name: string, planType: string, owed: Array<{ docType: string; label: string }>, docs: Record<string, string>, opts: { steps?: RecipeStep[]; discipline?: string } = {}) {
  counts.advance = 0; counts.filing = 0; counts.save = 0; counts.swallowed = 0;
  const page = await newPage();
  const adapter = new RecipeAdapter({ ...recipeOf(opts.steps ?? recipeSteps(planType)), ...(opts.discipline ? { discipline: opts.discipline } : {}) }, {}, docs, { owedAttachments: owed });
  (adapter as unknown as { page: unknown }).page = page;
  const result = await adapter.fillApplication({} as ProjectRecord);
  const url = page.url();
  const refusals = (adapter as unknown as { finalSubmitRefusalsNow: () => string[] }).finalSubmitRefusalsNow();
  await page.context().close();
  const data = (result.data ?? {}) as { attachmentLedger?: Array<{ docType: string; status: string; detail: string }>; driftWarnings?: string[]; agingNotes?: string[] };
  const out = { result, url, refusals, ledger: data.attachmentLedger ?? [], drift: (data.driftWarnings ?? []).join(" | "), aging: (data.agingNotes ?? []).join(" | "), rows: [...rows], ...counts };
  console.log(`  [${name}] ok=${result.ok} rows=${JSON.stringify(out.rows.map((r) => [r.name, r.type]))} advance=${counts.advance} filing=${counts.filing}\n         ledger=${JSON.stringify(out.ledger.map((l) => [l.docType, l.status]))}${result.ok ? "" : `\n         msg=${String(result.message ?? "").slice(0, 400)}`}`);
  return out;
}
const bad = (r: { type: string }) => /homeowner\s*acknowledg|contractor\s*responsibility/i.test(r.type);

console.log("\nT. the Type rule (attachmentTypes.ts) against the real list");
check("applications and the 5952 take 'Other' (the list has no Application / Checklist)", attachmentTypeFor("building_application", TYPES_REAL) === "Other" && attachmentTypeFor("electrical_application", TYPES_REAL) === "Other" && attachmentTypeFor("solar_checklist", TYPES_REAL) === "Other");
check("a spec is 'Specifications', a PE letter 'Structural Calculations', a site plan 'Plans - Site Plan'", attachmentTypeFor("module_spec", TYPES_REAL) === "Specifications" && attachmentTypeFor("structural_letter", TYPES_REAL) === "Structural Calculations" && attachmentTypeFor("site_plan", TYPES_REAL) === "Plans - Site Plan");
check("MUST-EXCLUDE never Homeowner Acknowledgement / Contractor Responsibility, even as the only non-placeholder option", attachmentTypeFor("building_application", ["--Select--", "Homeowner Acknowledgement", "Contractor Responsibility Form"]) === null);
check("MUST-EXCLUDE an unknown document type is not guessed", attachmentTypeFor("utility_bill", TYPES_REAL) === null && attachmentTypeFor("meter_photo", TYPES_REAL) === null);
check("the numbered Corvallis list: plan set '01 Plans', B-01S '03 Other Documents', spec '02 Specifications or Engineering'",
  attachmentTypeFor("plan_set", TYPES_CORVALLIS) === "01 Plans" && attachmentTypeFor("building_application", TYPES_CORVALLIS) === "03 Other Documents" && attachmentTypeFor("module_spec", TYPES_CORVALLIS) === "02 Specifications or Engineering");

/** THE LEARNER's attachment pass (autoLearnAdapter.accelaAttachmentSavePass) on the real page: the plan set
 *  handed to the Add control (what performUploads does), then the pass — it types the row, fills the
 *  Description and clicks Save. What it recorded, and what the portal saved. */
async function learnPass(permitType: string): Promise<{ saved: boolean; steps: RecipeStep[]; rows: typeof rows; swallowed: number }> {
  counts.save = 0; counts.swallowed = 0;
  const page = await newPage();
  await page.goto(`${base}${ATT_PATH}`);
  await page.setInputFiles(`#${FILE_ID}`, DOCS.plan_set);
  const planner: LearnPlanner = async () => ({ fills: [], atReview: false });
  const learner = new AutoLearnAdapter("Numbered Types smoke", planner, { docsByType: { plan_set: DOCS.plan_set }, uploadMode: "combined" });
  (learner as unknown as { page: unknown }).page = page;
  const steps: RecipeStep[] = [{ action: "upload", phase: "upload", selector: { css: `#${FILE_ID}` }, docType: "plan_set", note: "upload plan_set: Add" }];
  const saved = await (learner as unknown as { accelaAttachmentSavePass: (p: ProjectRecord, s: RecipeStep[]) => Promise<boolean> })
    .accelaAttachmentSavePass({ permitType } as ProjectRecord, steps);
  await page.context().close();
  console.log(`  [learn ${permitType}] saved=${saved} rows=${JSON.stringify(rows.map((r) => [r.name, r.type, r.value]))} steps=${JSON.stringify(steps.map((s) => [s.action, s.note, s.value]))} swallowed=${counts.swallowed}`);
  return { saved, steps, rows: [...rows], swallowed: counts.swallowed };
}
const typeStepOf = (steps: RecipeStep[]) => steps.find((s) => s.action === "select" && s.note === "attachment: document type");

console.log("\nU. the LEARNER on the numbered Corvallis list (live 2026-09-28 p016/p017: no Type chosen, Save refused)");
{
  rows = []; types = TYPES_CORVALLIS; typeValuePrefix = CV_PREFIX; typeMaskMs = 700;
  const o = await learnPass("Residential Building");
  const ts = typeStepOf(o.steps);
  check("MUST-PASS the pass recognises the numbered list and types the plan set's row '01 Plans' (selected by its coded value); the portal saves it",
    o.saved && o.rows.length === 1 && o.rows[0].type === "01 Plans" && o.rows[0].value === `${CV_PREFIX}01 Plans`, JSON.stringify(o.rows));
  check("MUST-PASS the stamped Type step is recorded with the option TEXT, beside the Description and the Save (as on ePermitting)",
    ts?.value === "01 Plans" && ts?.phase === "upload" && o.steps.some((s) => s.note === "attachment: description") && o.steps.some((s) => /^attachment: save\b/.test(String(s.note ?? ""))), JSON.stringify(o.steps));
  check("MUST-EXCLUDE the Save is never clicked under the Type's loading mask", o.swallowed === 0, `swallowed=${o.swallowed}`);
  rows = [];
  const e = await learnPass("Electrical");
  check("an electrical plan set on the same list is '01 Plans' too (the list does not split plans by trade)", e.saved && e.rows[0]?.type === "01 Plans" && typeStepOf(e.steps)?.value === "01 Plans", JSON.stringify(e.rows));
}

console.log("\nV. PINNED: the learner on Oregon ePermitting's list still picks the plan set's Type by trade");
{
  types = TYPES_REAL; typeValuePrefix = ""; typeMaskMs = 0;
  rows = [];
  const s = await learnPass("structural");
  check("building: 'Plans - Structural' saved and recorded", s.saved && s.rows[0]?.type === "Plans - Structural" && typeStepOf(s.steps)?.value === "Plans - Structural", JSON.stringify({ rows: s.rows, type: typeStepOf(s.steps) }));
  rows = [];
  const e = await learnPass("electrical");
  check("electrical: 'Plans - Electrical' saved and recorded", e.saved && e.rows[0]?.type === "Plans - Electrical" && typeStepOf(e.steps)?.value === "Plans - Electrical", JSON.stringify({ rows: e.rows, type: typeStepOf(e.steps) }));
}

console.log("\nA. Michael building: plan set + B-01S + 5952");
{
  rows = []; types = TYPES_REAL;
  const o = await replay("building", "Plans - Structural",
    [{ docType: "building_application", label: B01S }, { docType: "solar_checklist", label: C5952 }],
    { plan_set: DOCS.plan_set, building_application: DOCS.building_application, solar_checklist: DOCS.solar_checklist });
  const byName = (re: RegExp) => o.rows.find((r) => re.test(r.name));
  check("MUST-PASS exactly 3 rows: the plan set 'Plans - Structural', the B-01S 'Other', the 5952 'Other'",
    o.rows.length === 3 && byName(/Plan_Set_Fixture/)?.type === "Plans - Structural" && byName(/B-01S/)?.type === "Other" && byName(/5952/)?.type === "Other", JSON.stringify(o.rows));
  check("MUST-PASS each owed file is named as what it is, never tmpl-<uuid>.pdf", !o.rows.some((r) => /tmpl-/.test(r.name)) && !!byName(/^Marion County Prescriptive Solar .* B-01S\.pdf$/) && !o.rows.some((r) => /[().]/.test(r.name.replace(/\.pdf$/, ""))) && !!byName(/^Oregon BCD 440-5952 .*\.pdf$/), JSON.stringify(o.rows.map((r) => r.name)));
  check("MUST-PASS the description says what each document is", byName(/B-01S/)?.desc === B01S && byName(/5952/)?.desc === C5952, JSON.stringify(o.rows.map((r) => r.desc)));
  check("MUST-PASS the ledger says both attached; the approved final submit has nothing owed to refuse on",
    o.ledger.length === 2 && o.ledger.every((l) => l.status === "attached") && !o.refusals.some((r) => /owed document/.test(r)), JSON.stringify({ ledger: o.ledger, refusals: o.refusals }));
  check("one advance to the review page, 0 filing POSTs, never Homeowner Acknowledgement", o.advance === 1 && /CapConfirm/i.test(o.url) && o.filing === 0 && !o.rows.some(bad), `advance=${o.advance} filing=${o.filing} at=${o.url}`);
}

console.log("\nB. Michael electrical: plan set + E-01");
{
  rows = []; types = TYPES_REAL;
  const o = await replay("electrical", "Plans - Electrical", [{ docType: "electrical_application", label: E01 }],
    { plan_set: DOCS.plan_set, electrical_application: DOCS.electrical_application });
  check("MUST-PASS 2 rows: the plan set 'Plans - Electrical', the E-01 'Other'",
    o.rows.length === 2 && o.rows[0].type === "Plans - Electrical" && / E-01\.pdf$/.test(o.rows[1].name) && o.rows[1].type === "Other", JSON.stringify(o.rows));
}

console.log("\nC. MUST-EXCLUDE: no Type fits (a list with no 'Other')");
{
  rows = []; types = TYPES_REAL.filter((t) => t !== "Other");
  const o = await replay("no-other", "Plans - Structural", [{ docType: "building_application", label: B01S }],
    { plan_set: DOCS.plan_set, building_application: DOCS.building_application });
  check("the B-01S is NOT uploaded (only the plan set's row), and it is named NOT ATTACHED", o.rows.length === 1 && /Plan_Set_Fixture/.test(o.rows[0].name) && /NOT ATTACHED: Marion County Prescriptive/.test(o.drift) && o.ledger[0]?.status === "not attached", JSON.stringify({ rows: o.rows, drift: o.drift.slice(0, 300) }));
  check("the approved final submit REFUSES while it is owed", o.refusals.some((r) => /1 owed document\(s\) not attached/.test(r)), JSON.stringify(o.refusals));
}

console.log("\nD. MUST-EXCLUDE: a document the portal already lists is not uploaded twice");
{
  rows = [{ name: "Marion County Prescriptive Solar Photovoltaic Installation Permit Application B-01S.pdf", type: "Other", desc: B01S }]; types = TYPES_REAL;
  const o = await replay("already-listed", "Plans - Structural", [{ docType: "building_application", label: B01S }],
    { plan_set: DOCS.plan_set, building_application: DOCS.building_application });
  check("one new row (the plan set) — the listed B-01S is not attached again; the ledger says already listed",
    o.rows.length === 2 && o.rows.filter((r) => /B-01S/.test(r.name)).length === 1 && o.ledger[0]?.status === "already listed", JSON.stringify({ rows: o.rows, ledger: o.ledger }));
}

console.log("\nE. MUST-EXCLUDE: no owed list is today's single row");
{
  rows = []; types = TYPES_REAL;
  const o = await replay("no-owed", "Plans - Structural", [], { plan_set: DOCS.plan_set, building_application: DOCS.building_application });
  check("exactly one row, the plan set; no ledger entries", o.rows.length === 1 && o.ledger.length === 0, JSON.stringify(o.rows));
}

console.log("\nF. the OLDER static-row widget (its Type row is on the page before any file) still works");
{
  rows = []; types = TYPES_REAL; rowAfterUpload = false;
  const o = await replay("static-row", "Plans - Structural", [{ docType: "building_application", label: B01S }],
    { plan_set: DOCS.plan_set, building_application: DOCS.building_application });
  rowAfterUpload = true;
  check("MUST-PASS static row: plan set + B-01S ('Other'), the ledger says attached", o.rows.length === 2 && o.rows[1].type === "Other" && o.ledger[0]?.status === "attached", JSON.stringify({ rows: o.rows, ledger: o.ledger }));
}

console.log("\nG. Accela redraws its saved list seconds after the banner (live 090fa574): no false alarm");
{
  rows = []; types = TYPES_REAL; listDelayMs = 3000;
  const o = await replay("slow-list", "Plans - Electrical", [{ docType: "electrical_application", label: E01 }],
    { plan_set: DOCS.plan_set, electrical_application: DOCS.electrical_application });
  listDelayMs = 0;
  check("MUST-PASS a list that redraws late: the E-01 is attached, and nothing says the plan set is not listed",
    o.rows.length === 2 && o.ledger[0]?.status === "attached" && !/attachment list does not show/.test(o.drift), JSON.stringify({ rows: o.rows, ledger: o.ledger, drift: o.drift.slice(0, 300) }));
}

console.log("\nH. MUST-EXCLUDE: a refused Save leaves its row unsaved — the pass STOPS; the next document is never committed under it");
{
  rows = []; types = TYPES_REAL; failSaveFor = "B-01S";
  const saved0 = RecipeAdapter.ATTACH_LIST_WAIT_MS;
  RecipeAdapter.ATTACH_LIST_WAIT_MS = 4000;
  const o = await replay("refused-save", "Plans - Structural",
    [{ docType: "building_application", label: B01S }, { docType: "solar_checklist", label: C5952 }],
    { plan_set: DOCS.plan_set, building_application: DOCS.building_application, solar_checklist: DOCS.solar_checklist });
  RecipeAdapter.ATTACH_LIST_WAIT_MS = saved0; failSaveFor = "";
  check("only the plan set is saved; the B-01S is NOT ATTACHED (not confirmed) and the 5952 was NOT TRIED",
    o.rows.length === 1 && o.ledger.find((l) => l.docType === "building_application")?.status === "not attached"
      && /NOT CONFIRMED/.test(o.ledger.find((l) => l.docType === "building_application")?.detail ?? "")
      && /not tried/.test(o.ledger.find((l) => l.docType === "solar_checklist")?.detail ?? ""), JSON.stringify({ rows: o.rows, ledger: o.ledger }));
  check("the approved final submit refuses on both", o.refusals.some((r) => /2 owed document\(s\) not attached/.test(r)), JSON.stringify(o.refusals));
}

console.log("\nI. MUST-EXCLUDE (skeptic 21d2502 MF1): an ORDINARY form page — a Plan Set slot, Description of Work, Work Type, Save — never carries an owed document");
{
  rows = []; formSaves.length = 0;
  const FORM_STEPS: RecipeStep[] = [
    { action: "goto", value: `${base}/form`, note: "entry url" },
    { action: "upload", selector: { css: "#ps" }, docType: "plan_set", viaFileChooser: false, note: "upload plan_set: Plan Set" },
    { action: "fill", selector: { css: "textarea" }, value: "Install roof-mounted PV", note: "Description of Work" },
    { action: "select", selector: { css: "select" }, value: "Alteration", note: "Work Type" },
    { action: "click", selector: { css: "#sv" }, note: "save" },
    { action: "click", selector: { css: "#next" }, note: "advance: Continue Application »" },
  ];
  const page = await newPage();
  const adapter = new RecipeAdapter({ ...recipeOf(FORM_STEPS), portalUrl: `${base}/form` }, {}, { plan_set: DOCS.plan_set, electrical_application: DOCS.electrical_application },
    { owedAttachments: [{ docType: "electrical_application", label: E01 }] });
  (adapter as unknown as { page: unknown }).page = page;
  const result = await adapter.fillApplication({} as ProjectRecord);
  await page.waitForTimeout(500);
  const formRefusals = (adapter as unknown as { finalSubmitRefusalsNow: () => string[] }).finalSubmitRefusalsNow();
  await page.context().close();
  const ledger = ((result.data ?? {}) as { attachmentLedger?: Array<{ docType: string; status: string; detail: string }> }).attachmentLedger ?? [];
  const saves = formSaves.map((b) => { try { return JSON.parse(b); } catch { return {}; } });
  console.log(`  [form-page] saves=${JSON.stringify(saves)} ledger=${JSON.stringify(ledger)}`);
  check("the form was saved ONCE, with its own description, type and the PLAN SET — never the E-01",
    saves.length === 1 && saves[0].desc === "Install roof-mounted PV" && saves[0].workType === "Alteration" && /Plan_Set_Fixture/.test(saves[0].planFile), JSON.stringify(saves));
  check("the E-01 is named NOT ATTACHED (no attachment row carried it)", ledger.length === 1 && ledger[0].status === "not attached", JSON.stringify(ledger));
  // (skeptic eb36a8f N1) a form's own Save is not a recorded attachment row: a list check there warns,
  // never marks the plan set unconfirmed for the final-submit refusal.
  check("MUST-EXCLUDE a form page's Save never yields a 'never showed plan_set' refusal", !formRefusals.some((r) => /never showed plan_set/.test(r)), JSON.stringify(formRefusals));
}

console.log("\nJ. (skeptic 13985c6 S1/S2) the recorded plan set's Save is SILENTLY refused — its pending row stays with 'File: <name>'");
{
  rows = []; types = TYPES_REAL; silentRefuseFor = "Plan_Set"; saveAttempts.length = 0;
  const saved0 = RecipeAdapter.ATTACH_LIST_WAIT_MS;
  RecipeAdapter.ATTACH_LIST_WAIT_MS = 4000;
  const o = await replay("plan-set-silent", "Plans - Electrical", [{ docType: "electrical_application", label: E01 }],
    { plan_set: DOCS.plan_set, electrical_application: DOCS.electrical_application });
  RecipeAdapter.ATTACH_LIST_WAIT_MS = saved0; silentRefuseFor = "";
  const attempts = saveAttempts.map((b) => { try { return JSON.parse(b); } catch { return {}; } });
  check("MUST-EXCLUDE the pending row's 'File: <name>' is NOT 'listed': the plan set is named not shown", /attachment list does not show "Plan_Set_Fixture\.pdf"/.test(o.drift), o.drift.slice(0, 300));
  check("MUST-EXCLUDE the owed pass does NOT start on top of it: no E-01 upload, and the plan set row is never re-described / retyped",
    o.rows.length === 0 && attempts.length === 1 && attempts[0].desc === "Solar PV plan set" && attempts[0].type === "Plans - Electrical"
      && o.ledger[0]?.status === "not attached" && /not tried/.test(o.ledger[0]?.detail ?? ""), JSON.stringify({ attempts, ledger: o.ledger }));
  check("the approved final submit refuses: the plan set was never shown on the list, and the E-01 is owed",
    o.refusals.some((r) => /never showed plan_set/.test(r)) && o.refusals.some((r) => /owed document/.test(r)), JSON.stringify(o.refusals));
}

console.log("\nK. (S3) the owed E-01's Save is silently refused and its Type resets — 'File: <name>' stays");
{
  rows = []; types = TYPES_REAL; silentRefuseFor = "E-01"; resetTypeOnRefuse = true; saveAttempts.length = 0;
  const saved0 = RecipeAdapter.ATTACH_LIST_WAIT_MS;
  RecipeAdapter.ATTACH_LIST_WAIT_MS = 4000;
  const o = await replay("owed-silent", "Plans - Electrical", [{ docType: "electrical_application", label: E01 }],
    { plan_set: DOCS.plan_set, electrical_application: DOCS.electrical_application });
  RecipeAdapter.ATTACH_LIST_WAIT_MS = saved0; silentRefuseFor = ""; resetTypeOnRefuse = false;
  check("MUST-EXCLUDE never 'attached': the E-01 is NOT CONFIRMED, and the approved submit refuses",
    o.rows.length === 1 && o.ledger[0]?.status === "not attached" && /NOT CONFIRMED/.test(o.ledger[0]?.detail ?? "") && o.refusals.some((r) => /owed document/.test(r)),
    JSON.stringify({ rows: o.rows, ledger: o.ledger, refusals: o.refusals }));
}

console.log("\nL. (S7b) the owed file's exact name printed in the page's instructions is not 'already listed'");
{
  rows = []; types = TYPES_REAL; instructionsName = "Marion County Renewable Electrical Energy Permit Application E-01.pdf";
  const o = await replay("name-in-help", "Plans - Electrical", [{ docType: "electrical_application", label: E01 }],
    { plan_set: DOCS.plan_set, electrical_application: DOCS.electrical_application });
  instructionsName = "";
  check("the E-01 is uploaded and attached (a help paragraph is not the list)", o.rows.length === 2 && o.ledger[0]?.status === "attached", JSON.stringify({ rows: o.rows, ledger: o.ledger }));
}

console.log("\nM. (S4) a recorded upload a rule skips never refuses the approved submit");
{
  rows = []; types = TYPES_REAL;
  const steps = recipeSteps("Plans - Electrical");
  const withBattery: RecipeStep[] = [...steps.slice(0, 5), { action: "upload", selector: { css: '[data-al-upl="f0"]' }, docType: "battery_spec", viaFileChooser: false, note: "upload battery_spec: Battery Specification Sheet", optional: true }, ...steps.slice(5)];
  const page = await newPage();
  // The spec IS on hand (skeptic eb36a8f MF1): the skip must come from the no-battery rule, not a missing file.
  const adapter = new RecipeAdapter(recipeOf(withBattery), { hasBattery: "No" }, { plan_set: DOCS.plan_set, battery_spec: pdfAt("Battery_Spec_Fixture.pdf") }, {});
  (adapter as unknown as { page: unknown }).page = page;
  await adapter.fillApplication({} as ProjectRecord);
  const refusals = (adapter as unknown as { finalSubmitRefusalsNow: () => string[] }).finalSubmitRefusalsNow();
  await page.context().close();
  check("no 'did not happen' / 'never showed' refusal for a battery spec on a job with no battery (file on hand, rule skips it)",
    !refusals.some((r) => /did not happen|never showed/.test(r)) && !rows.some((r) => /Battery_Spec/.test(r.name)), JSON.stringify({ refusals, rows }));
}

console.log("\nN. (skeptic eb36a8f MF1) a REQUIRED recorded upload whose file is not on hand refuses the approved submit");
{
  rows = []; types = TYPES_REAL;
  const steps = recipeSteps("Plans - Electrical");
  const withSld: RecipeStep[] = [...steps.slice(0, 5), { action: "upload", selector: { css: '[data-al-upl="f0"]' }, docType: "single_line_diagram", viaFileChooser: false, note: "upload single_line_diagram: Single Line Diagram" }, ...steps.slice(5)];
  const page = await newPage();
  const adapter = new RecipeAdapter(recipeOf(withSld), {}, { plan_set: DOCS.plan_set }, {});
  (adapter as unknown as { page: unknown }).page = page;
  await adapter.fillApplication({} as ProjectRecord);
  const refusals = (adapter as unknown as { finalSubmitRefusalsNow: () => string[] }).finalSubmitRefusalsNow();
  await page.context().close();
  check("MUST-EXCLUDE the missing single-line diagram is refused, never exempted", refusals.some((r) => /upload of single_line_diagram did not happen/.test(r)), JSON.stringify(refusals));
}

console.log("\nO. (skeptic eb36a8f MF2) a required-document list the backend could not read refuses the approved submit");
{
  rows = []; types = TYPES_REAL;
  const o = await replay("unreadable-list", "Plans - Electrical", [{ docType: "__unreadable__", label: "the required-document list could not be read" }],
    { plan_set: DOCS.plan_set });
  check("MUST-EXCLUDE refused on the unreadable list, and the sentinel is never uploaded or ledgered as a document",
    o.refusals.some((r) => /required-document list for this filing could not be read/.test(r)) && o.rows.length === 1 && o.ledger.length === 0, JSON.stringify({ refusals: o.refusals, rows: o.rows, ledger: o.ledger }));
}

const CORVALLIS_OWED = [{ docType: "building_application", label: B01S }, { docType: "module_spec", label: SPEC }];
const CORVALLIS_DOCS = { plan_set: DOCS.plan_set, building_application: DOCS.building_application, module_spec: DOCS.module_spec };
const corvallisRows = (o: { rows: typeof rows }) => ({
  plan: o.rows.find((r) => /Plan_Set_Fixture/.test(r.name)),
  b01s: o.rows.find((r) => /B-01S/.test(r.name)),
  spec: o.rows.find((r) => /module specification/i.test(r.name)),
});

console.log("\nW. replay on the numbered Corvallis list with the recorded Type step '01 Plans' (what the learner now records): plan set + B-01S + module spec");
{
  rows = []; types = TYPES_CORVALLIS; typeValuePrefix = CV_PREFIX; typeMaskMs = 700;
  const o = await replay("corvallis-typed", "01 Plans", CORVALLIS_OWED, CORVALLIS_DOCS);
  const r = corvallisRows(o);
  check("MUST-PASS 3 rows: the plan set '01 Plans', the B-01S '03 Other Documents', the spec '02 Specifications or Engineering'",
    o.rows.length === 3 && r.plan?.type === "01 Plans" && r.b01s?.type === "03 Other Documents" && r.spec?.type === "02 Specifications or Engineering", JSON.stringify(o.rows));
  check("the ledger says both attached; one advance, 0 filing POSTs, no Save under the Type's mask",
    o.ledger.length === 2 && o.ledger.every((l) => l.status === "attached") && o.advance === 1 && o.filing === 0 && o.swallowed === 0, JSON.stringify({ ledger: o.ledger, advance: o.advance, filing: o.filing, swallowed: o.swallowed }));
}

console.log("\nX. replay of a recipe with NO Type step and no Description step (the Corvallis recording: a person picked the Type by hand)");
{
  rows = []; types = TYPES_CORVALLIS; typeValuePrefix = CV_PREFIX; typeMaskMs = 700;
  const o = await replay("corvallis-untyped", "", CORVALLIS_OWED, CORVALLIS_DOCS, { steps: untypedSteps() });
  const r = corvallisRows(o);
  check("MUST-PASS the plan set's row still saves, as '01 Plans' — its Type chosen by the document before the recorded Save",
    r.plan?.type === "01 Plans" && r.plan?.value === `${CV_PREFIX}01 Plans` && !/attachment list does not show "Plan_Set_Fixture/.test(o.drift), JSON.stringify({ rows: o.rows, drift: o.drift.slice(0, 300) }));
  check("MUST-PASS the owed rows through it are typed the same way: the B-01S '03 Other Documents', the spec '02 Specifications or Engineering'; both attached",
    o.rows.length === 3 && r.b01s?.type === "03 Other Documents" && r.spec?.type === "02 Specifications or Engineering" && o.ledger.length === 2 && o.ledger.every((l) => l.status === "attached"),
    JSON.stringify({ rows: o.rows, ledger: o.ledger }));
  check("the run says what it chose; one advance to the review page, 0 filing POSTs, no Save under the mask, nothing refused",
    /has no Type step — chose "01 Plans"/.test(o.aging) && o.advance === 1 && /CapConfirm/i.test(o.url) && o.filing === 0 && o.swallowed === 0 && !o.refusals.some((x) => /owed document|never showed/.test(x)),
    JSON.stringify({ aging: o.aging.slice(0, 400), advance: o.advance, filing: o.filing, swallowed: o.swallowed, refusals: o.refusals }));
}

console.log("\nY. PINNED: a recipe with no Type step on Oregon ePermitting's list types the plan set by the recipe's trade");
{
  rows = []; types = TYPES_REAL; typeValuePrefix = ""; typeMaskMs = 0;
  const o = await replay("oregon-untyped-electrical", "", [{ docType: "electrical_application", label: E01 }],
    { plan_set: DOCS.plan_set, electrical_application: DOCS.electrical_application }, { steps: untypedSteps(), discipline: "electrical" });
  check("electrical recipe: the plan set 'Plans - Electrical', the E-01 'Other'", o.rows.length === 2 && o.rows[0].type === "Plans - Electrical" && o.rows[1].type === "Other" && o.ledger[0]?.status === "attached", JSON.stringify({ rows: o.rows, ledger: o.ledger }));
  rows = [];
  const b = await replay("oregon-untyped-building", "", [], { plan_set: DOCS.plan_set }, { steps: untypedSteps() });
  check("building (no discipline named): the plan set 'Plans - Structural' — never Homeowner Acknowledgement", b.rows.length === 1 && b.rows[0].type === "Plans - Structural" && !b.rows.some(bad), JSON.stringify(b.rows));
}

await browser.close();
server.close();
console.log(`\nrepeatableAttach: ${passes} passed, ${failures} failed (of ${passes + failures} checks)`);
if (failures) { console.error(`repeatableAttach: ${failures} check(s) FAILED`); process.exit(1); }
console.log("repeatableAttach: all checks passed (real Chromium, captured Accela chrome, the real Type list)");
