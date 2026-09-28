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
let types = TYPES_REAL;
let rows: Array<{ name: string; type: string; desc: string }> = [];
const counts = { advance: 0, filing: 0, save: 0 };
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function attachmentsContent(): string {
  const body = rows.length
    ? rows.map((r) => `<tr class="ACA_TabRow_Odd"><td>${esc(r.name)}</td><td>${esc(r.type)}</td><td>16 B</td><td>09/27/2026</td><td><a href="javascript:void(0)">Actions</a></td></tr>`).join("")
    : `<tr><td colspan="5">No records found.</td></tr>`;
  return `<div ng-non-bindable="true" id="attachmentSection">
  <div class="ACA_TabRow"><div class="ACA_Title_Bar"><h1>Attachment</h1></div></div>
  <p>The maximum file size allowed is 80 MB.</p>
  <table id="${PM}attachmentEdit_gdvAttachmentList" class="ACA_GridView"><tr><th>Name</th><th>Type</th><th>Size</th><th>Latest Update</th><th>Action</th></tr>${body}</table>
  <div id="uploadWidget">
    <input type="file" id="${FILE_ID}" name="${FILE_ID.replace(/_/g, "$")}" accept=".pdf" style="width:90px">
    <div id="pending" style="display:none">
      <label for="${PM}attachmentEdit_txtDescription">*Description:</label> <textarea id="${PM}attachmentEdit_txtDescription" rows="4" cols="60"></textarea>
      <label for="${PM}attachmentEdit_ddlType">*Type (Required):</label> <select id="${PM}attachmentEdit_ddlType">${types.map((t) => `<option value="${t === "--Select--" ? "" : esc(t)}">${esc(t)}</option>`).join("")}</select>
      <div>File: <span id="fname"></span> <span class="progress">100%</span></div>
    </div>
    <a id="${PM}attachmentEdit_btnSave" class="ACA_SmButton" href="javascript:void(0)" onclick="saveAttachment();return false;">Save</a>
    <label for="${FILE_ID}" id="${PM}attachmentEdit_btnAdd" class="ACA_SmButton">Add</label>
  </div>
  <script>(function(){
    var fi = document.getElementById('${FILE_ID}');
    var ta = document.getElementById('${PM}attachmentEdit_txtDescription');
    var dd = document.getElementById('${PM}attachmentEdit_ddlType');
    fi.addEventListener('change', function(){ if (fi.files && fi.files[0]) { document.getElementById('pending').style.display = 'block'; document.getElementById('fname').textContent = fi.files[0].name; } });
    window.saveAttachment = function(){
      var name = fi.files && fi.files[0] ? fi.files[0].name : '';
      if (!name || !dd.value) { var e = document.getElementById('err') || document.createElement('div'); e.id = 'err'; e.className = 'ACA_Message_Error'; e.textContent = 'Type (Required): please select a value.'; document.getElementById('uploadWidget').appendChild(e); return; }
      fetch('/save', { method: 'POST', body: JSON.stringify({ name: name, type: dd.value, desc: ta.value }) }).then(function(){ location.reload(); });
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
      if (url.pathname === "/save") { counts.save++; try { rows.push(JSON.parse(body)); } catch { /* malformed */ } res.writeHead(200); res.end("ok"); return; }
      const target = new URLSearchParams(body).get("__EVENTTARGET") || "";
      if (/CapConfirm/i.test(url.pathname) && target === ACTION_CONTINUE) { counts.filing++; send("<!doctype html><html><body><h1>Record Issuance</h1><p>Your application has been successfully submitted.</p></body></html>"); return; }
      if (target === ACTION_CONTINUE && /pageNumber=2/.test(url.search)) { counts.advance++; res.writeHead(302, { location: CONFIRM_PATH }); res.end(); return; }
      send(attachmentsPage());
    });
    return;
  }
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
};
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
async function replay(name: string, planType: string, owed: Array<{ docType: string; label: string }>, docs: Record<string, string>) {
  counts.advance = 0; counts.filing = 0; counts.save = 0;
  const page = await newPage();
  const adapter = new RecipeAdapter(recipeOf(recipeSteps(planType)), {}, docs, { owedAttachments: owed });
  (adapter as unknown as { page: unknown }).page = page;
  const result = await adapter.fillApplication({} as ProjectRecord);
  const url = page.url();
  const refusals = (adapter as unknown as { finalSubmitRefusalsNow: () => string[] }).finalSubmitRefusalsNow();
  await page.context().close();
  const data = (result.data ?? {}) as { attachmentLedger?: Array<{ docType: string; status: string; detail: string }>; driftWarnings?: string[]; agingNotes?: string[] };
  const out = { result, url, refusals, ledger: data.attachmentLedger ?? [], drift: (data.driftWarnings ?? []).join(" | "), aging: (data.agingNotes ?? []).join(" | "), rows: [...rows], ...counts };
  console.log(`  [${name}] ok=${result.ok} rows=${JSON.stringify(out.rows.map((r) => [r.name, r.type]))} advance=${counts.advance} filing=${counts.filing}\n         ledger=${JSON.stringify(out.ledger.map((l) => [l.docType, l.status]))}`);
  return out;
}
const bad = (r: { type: string }) => /homeowner\s*acknowledg|contractor\s*responsibility/i.test(r.type);

console.log("\nT. the Type rule (attachmentTypes.ts) against the real list");
check("applications and the 5952 take 'Other' (the list has no Application / Checklist)", attachmentTypeFor("building_application", TYPES_REAL) === "Other" && attachmentTypeFor("electrical_application", TYPES_REAL) === "Other" && attachmentTypeFor("solar_checklist", TYPES_REAL) === "Other");
check("a spec is 'Specifications', a PE letter 'Structural Calculations', a site plan 'Plans - Site Plan'", attachmentTypeFor("module_spec", TYPES_REAL) === "Specifications" && attachmentTypeFor("structural_letter", TYPES_REAL) === "Structural Calculations" && attachmentTypeFor("site_plan", TYPES_REAL) === "Plans - Site Plan");
check("MUST-EXCLUDE never Homeowner Acknowledgement / Contractor Responsibility, even as the only non-placeholder option", attachmentTypeFor("building_application", ["--Select--", "Homeowner Acknowledgement", "Contractor Responsibility Form"]) === null);
check("MUST-EXCLUDE an unknown document type is not guessed", attachmentTypeFor("utility_bill", TYPES_REAL) === null && attachmentTypeFor("meter_photo", TYPES_REAL) === null);

console.log("\nA. Michael building: plan set + B-01S + 5952");
{
  rows = []; types = TYPES_REAL;
  const o = await replay("building", "Plans - Structural",
    [{ docType: "building_application", label: B01S }, { docType: "solar_checklist", label: C5952 }],
    { plan_set: DOCS.plan_set, building_application: DOCS.building_application, solar_checklist: DOCS.solar_checklist });
  const byName = (re: RegExp) => o.rows.find((r) => re.test(r.name));
  check("MUST-PASS exactly 3 rows: the plan set 'Plans - Structural', the B-01S 'Other', the 5952 'Other'",
    o.rows.length === 3 && byName(/Plan_Set_Fixture/)?.type === "Plans - Structural" && byName(/B-01S/)?.type === "Other" && byName(/5952/)?.type === "Other", JSON.stringify(o.rows));
  check("MUST-PASS each owed file is named as what it is, never tmpl-<uuid>.pdf", !o.rows.some((r) => /tmpl-/.test(r.name)) && !!byName(/^Marion County Prescriptive Solar .*\(B-01S\)\.pdf$/) && !!byName(/^Oregon BCD 440-5952 .*\.pdf$/), JSON.stringify(o.rows.map((r) => r.name)));
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
    o.rows.length === 2 && o.rows[0].type === "Plans - Electrical" && /\(E-01\)\.pdf$/.test(o.rows[1].name) && o.rows[1].type === "Other", JSON.stringify(o.rows));
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
  rows = [{ name: `${B01S}.pdf`, type: "Other", desc: B01S }]; types = TYPES_REAL;
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

await browser.close();
server.close();
console.log(`\nrepeatableAttach: ${passes} passed, ${failures} failed (of ${passes + failures} checks)`);
if (failures) { console.error(`repeatableAttach: ${failures} check(s) FAILED`); process.exit(1); }
console.log("repeatableAttach: all checks passed (real Chromium, captured Accela chrome, the real Type list)");
