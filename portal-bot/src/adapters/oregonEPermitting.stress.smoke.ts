// End-to-end stress test — Oregon ePermitting (Accela ACA) adapter, intake → submittal.
//
// Drives the REAL OregonEPermittingAdapter (no copy) through its full public
// sequence — openSubmission → fillApplication → uploadFiles → stopAtReview —
// for BOTH permit disciplines, against a faithful in-process mock of the Accela
// ACA multi-page postback flow served by Playwright route interception. No
// external network, no live portal, no credentials: every navigation and fetch
// to aca-oregon.accela.com is fulfilled locally.
//
//   structural  → CITY jurisdiction row + "Residential - Structural" app type
//   electrical  → COUNTY jurisdiction row + "Residential - Electrical" app type + kVA tier
//
// The fixture below is SYNTHETIC (no real homeowner PII / account / meter), but
// shaped exactly like a real staged project — dcKw 5.28 to exercise the 5.01-15
// kVA tier, "100 N Example St" to exercise the street-direction/suffix parser —
// so the assertions match what a live run would produce.
//
// Safety invariant asserted: the final "Submit Application" button is DETECTED by
// stopAtReview but NEVER clicked. The mock flags any hit to the submit URL as a
// violation and the run fails if it is ever reached.
//
// Run:  npm run portal:test:stress
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { ProjectRecord } from "../../../shared/src/types";
import { OregonEPermittingAdapter } from "./oregonEPermitting";

const HOST = "aca-oregon.accela.com";

// ── synthetic past-project fixture (PII-free, type-correct ProjectRecord) ─────
const FIXTURE: ProjectRecord = {
  id: "stress-fixture-001",
  clientId: null,
  homeownerName: "Pat Example",
  projectAddress: "100 N Example St, Testville, OR, 97000",
  city: "Testville",
  state: "OR",
  zip: "97000",
  ahj: "City of Testville",
  utility: "PGE",
  accountNumber: "0000000000",
  meterNumber: "00000000",
  systemSizeDcKw: 5.28,
  systemSizeAcKw: 4.608,
  totalExportKw: null,
  interconnectionMethod: "Load-side breaker",
  // `submit_staging` was removed from ProjectStatus (2026-09-19) — it had zero writers.
  // `ready_to_stage` is the surviving status for "fully staged, not yet in the portal",
  // which is what this fixture models. currentStage below is free-text PROSE, not a
  // status, and is deliberately left as-is: a recorded label is a matching key.
  status: "ready_to_stage",
  currentStage: "submit_staging",
  parserConfidenceSummary: "",
  parserSnapshot: {
    moduleManufacturer: "Example Solar",
    moduleModel: "EX-440",
    moduleQuantity: "12",
    moduleWatts: "440",
    inverterManufacturer: "Example Inverters",
    inverterModel: "EX-INV",
    inverterQuantity: "6",
    hasBattery: "No",
    jobValue: "$25,000",
    installerCompanyName: "EXAMPLE SOLAR LLC",
    installerEmail: "permits@example.test",
    mainServiceRating: "200A",
    pvArrays: [{ quantity: "12", moduleManufacturer: "Example Solar", moduleModel: "EX-440", tilt: "30", azimuth: "172" }],
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const CITY_UPPER = FIXTURE.city.toUpperCase();
const ADDR_UPPER = `100 N EXAMPLE ST, ${CITY_UPPER}, OR ${FIXTURE.zip}`;

// ── tiny assertion framework ────────────────────────────────────────────────
const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── mock HTML builders ──────────────────────────────────────────────────────
const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>
   <div class="message-bar" style="display:none"></div>${body}</body></html>`;

// A "Continue Application" link that records the page's field values then navigates.
// If `requireJobValue` and the Job Value field is empty, it shows a message bar and
// does NOT navigate (mirrors Accela's server-side validation → adapter detects it).
//
// CRITICAL: the record fetch is fire-and-forget (keepalive) and the navigation is
// SYNCHRONOUS within the click tick. Awaiting the fetch before navigating races
// the adapter's waitForLoadState("networkidle") and causes flaky "page did not
// advance" failures — see the projectinfo race fixed during development.
function continueLink(step: string, nextHref: string, requireJobValue = false) {
  return `<a id="continueApp" href="#" onclick="return _cont(event)">Continue Application »</a>
  <script>
   function _cont(e){
     e.preventDefault();
     var fields={};
     document.querySelectorAll('input,select,textarea').forEach(function(el){
       var key = el.getAttribute('aria-label') || el.id || el.name || '';
       if(!key) return;
       if(el.type==='checkbox'){ fields[key]= el.checked; }
       else { fields[key]= el.value; }
     });
     ${requireJobValue ? `
     var jv = fields['Job Value($):'];
     if(!jv){ var mb=document.querySelector('.message-bar'); mb.textContent='Job Value is required.'; mb.style.display='block'; return false; }
     ` : ``}
     try { fetch('/oregon/mock/record',{method:'POST',keepalive:true,body:JSON.stringify({step:'${step}',fields:fields})}); } catch(_){}
     window.location.href='${nextHref}';
     return false;
   }
  </script>`;
}

// Generic mock-network log. Records every field POST and any submit-URL hit.
const recorded: Record<string, Record<string, unknown>> = {};
let submitViolation = false;

function disclaimer() {
  return page("Disclaimer", `
    <h2>Building Department Application — Disclaimer</h2>
    <input type="checkbox" id="ctl00_PlaceHolderMain_refLicenseSeqNumber_termAccept"
           aria-label="I have read and agree to the above terms and conditions">
    <label>I have read and agree to the above terms and conditions</label>
    <a id="continueApp" href="/oregon/Cap/WorkLocation.aspx">Continue Application »</a>`);
}

function workLocation() {
  return page("Work Location", `
    <h2>Step 1: Work Location</h2>
    Street No: <input type="text" id="ctl00_PlaceHolderMain_addressSearch_txtStreetNo4Search_ChildControl0">
    Street Name: <input type="text" id="ctl00_PlaceHolderMain_addressSearch_txtStreetName">
    Direction: <select id="ctl00_PlaceHolderMain_addressSearch_ddlStreetDirection">
      <option value=""></option><option value="N">N</option><option value="S">S</option>
      <option value="E">E</option><option value="W">W</option></select>
    <a id="ctl00_PlaceHolderMain_addressSearch_WorkLocationEdit_btnSearch"
       href="/oregon/Cap/WorkLocationResults.aspx">Search</a>`);
}

function workLocationResults() {
  // SAME street under two jurisdictions — adapter must pick the row matching the
  // discipline (filtered by uppercase city). Row text drives the openSubmission
  // jurisdictionRow.filter({ hasText: cityUpper }) selection.
  return page("Address Results", `
    <h2>Address Search Results</h2>
    <table><tbody>
      <tr><td>CITY APPLICATIONS</td><td>${ADDR_UPPER}</td>
          <td><a href="/oregon/Cap/CapApplyType.aspx?j=city">Select</a></td></tr>
      <tr><td>COUNTY APPLICATIONS</td><td>${ADDR_UPPER}</td>
          <td><a href="/oregon/Cap/CapApplyType.aspx?j=county">Select</a></td></tr>
    </tbody></table>`);
}

function appType(j: string) {
  return page("Application Type", `
    <h2>Select Application Type (jurisdiction=${j})</h2>
    <input type="checkbox" id="appStruct" aria-label="Residential - Structural Permit">
    <label>Residential - Structural Permit</label><br>
    <input type="checkbox" id="appElec" aria-label="Residential - Electrical Comprehensive Permit">
    <label>Residential - Electrical Comprehensive Permit</label><br>
    <a id="continueApp" href="#" onclick="return _at(event)">Continue Application »</a>
    <script>
     function _at(e){ e.preventDefault();
       var f={struct:document.getElementById('appStruct').checked, elec:document.getElementById('appElec').checked, j:'${j}'};
       try { fetch('/oregon/mock/record',{method:'POST',keepalive:true,body:JSON.stringify({step:'apptype',fields:f})}); } catch(_){}
       window.location.href='/oregon/Cap/CapDetail.aspx?step=parcel&j=${j}';
       return false; }
    </script>`);
}

function parcelConfirm(j: string) {
  return page("Parcel Confirmation", `
    <h2>Parcel Information (confirm)</h2><p>Parcel auto-matched. No input required.</p>
    ${continueLink("parcel", `/oregon/Cap/CapDetail.aspx?step=owner&j=${j}`)}`);
}

function ownerConfirm(j: string) {
  return page("Owner Confirmation", `
    <h2>Owner Information (confirm)</h2><p>Owner auto-matched. No input required.</p>
    ${continueLink("owner", `/oregon/Cap/CapDetail.aspx?step=projectinfo&j=${j}`)}`);
}

function projectInfo(j: string) {
  return page("Project Information", `
    <h2>Project Information</h2>
    <table><tbody>
      <tr><td>Job Value($):</td><td><input type="text" aria-label="Job Value($):"></td></tr>
      <tr><td>Category of Construction</td><td>
        <select aria-label="Category of Construction">
          <option value="">--Select--</option><option value="1">Residential</option>
          <option value="2">Commercial</option></select></td></tr>
      <tr><td>Project Name</td><td><input type="text" aria-label="Project Name"></td></tr>
      <tr><td>Description of Work</td><td><textarea aria-label="Description of Work"></textarea></td></tr>
    </tbody></table>
    ${continueLink("projectinfo", `/oregon/Cap/CapDetail.aspx?step=contacts&j=${j}`, true)}`);
}

function contacts(j: string) {
  // Exercises the "Select from Account" → ACADialogFrame path (contactAdded=true).
  return page("Contacts", `
    <h2>Contact Information</h2>
    <div id="dlgHost"></div>
    <a id="selFromAcct" href="#" onclick="return _openDlg(event)">Select from Account</a>
    ${continueLink("contacts", `/oregon/Cap/CapDetail.aspx?step=construction&j=${j}`)}
    <script>
     function _openDlg(e){ e.preventDefault();
       var f=document.createElement('iframe'); f.name='ACADialogFrame';
       f.src='/oregon/Cap/ContactDialog.aspx'; f.style.width='400px'; f.style.height='200px';
       document.getElementById('dlgHost').appendChild(f); return false; }
    </script>`);
}

function contactDialog() {
  return page("Select Contact", `
    <h3>Account Contacts</h3>
    <table><tbody><tr><td><input type="checkbox" id="c1"></td><td>EXAMPLE SOLAR LLC</td></tr></tbody></table>
    <a href="#" onclick="parent.postMessage('contactPicked','*');this.textContent='Picked';return false;">Continue</a>`);
}

function constructionStructural(j: string) {
  return page("Construction Details (Structural)", `
    <h2>Construction Details</h2>
    <table><tbody>
      <tr><td>Category of Construction</td><td>
        <select aria-label="cat" onchange="_otherCat(this)">
          <option value="">--</option><option value="o">Other</option><option value="r">Residential</option></select></td></tr>
      <tr id="otherCatRow" style="display:none"><td>Other Category of Construction</td>
          <td><input type="text" aria-label="othercat"></td></tr>
      <tr><td>Type of Work</td><td>
        <select aria-label="tow"><option value="">--</option><option value="alt">Alteration</option>
          <option value="add">Addition</option><option value="new">New</option></select></td></tr>
      <tr><td>Project includes any of the following</td><td>
        <select aria-label="incl"><option value="">--</option><option value="na">Not Applicable</option></select></td></tr>
      <tr><td>Building Height</td><td><input type="text" aria-label="bh"></td></tr>
      <tr><td>Number of Stories</td><td><input type="text" aria-label="nos"></td></tr>
      <tr><td>New Building Area</td><td><input type="text" aria-label="nba"></td></tr>
      <tr><td>Existing Building Area</td><td><input type="text" aria-label="eba"></td></tr>
    </tbody></table>
    ${continueLink("construction", `/oregon/Cap/CapDetail.aspx?step=documents&j=${j}`)}
    <script>function _otherCat(s){document.getElementById('otherCatRow').style.display=s.value==='o'?'':'none';}</script>`);
}

function constructionElectrical(j: string) {
  return page("Electrical Services", `
    <h2>Electrical Services</h2>
    <table><tbody>
      <tr><td>Category of Construction</td><td>
        <select aria-label="cat" onchange="_otherCat(this)">
          <option value="">--</option><option value="o">Other</option><option value="r">Residential</option></select></td></tr>
      <tr id="otherCatRow" style="display:none"><td>Other Category of Construction</td>
          <td><input type="text" aria-label="othercat"></td></tr>
      <tr><td>Type of Work</td><td>
        <select aria-label="tow"><option value="">--</option><option value="new">New</option>
          <option value="alt">Alteration</option></select></td></tr>
      <tr><td>Project includes any of the following</td><td>
        <select aria-label="incl"><option value="">--</option><option value="na">Not Applicable</option></select></td></tr>
      <tr><td>Renewable Energy System 5 kVA or less</td><td><input type="text" aria-label="kva5"></td></tr>
      <tr><td>Renewable Energy System 5.01 to 15 kVA</td><td><input type="text" aria-label="kva15"></td></tr>
      <tr><td>Renewable Energy System 15.01 to 25 kVA</td><td><input type="text" aria-label="kva25"></td></tr>
    </tbody></table>
    ${continueLink("construction", `/oregon/Cap/CapDetail.aspx?step=documents&j=${j}`)}
    <script>function _otherCat(s){document.getElementById('otherCatRow').style.display=s.value==='o'?'':'none';}</script>`);
}

function documents(j: string) {
  // Upload section: "Add" → ACADialogFrame (inner Add, file input, Upload) → Description + Type + Save.
  return page("Documents", `
    <h2>Attach Documents</h2>
    <div id="dlgHost"></div>
    <a id="addDoc" href="#" onclick="return _openUp(event)">Add</a>
    <table><tbody>
      <tr><td>Description</td><td><input type="text" aria-label="Description"></td></tr>
      <tr><td>Type (Required)</td><td><select aria-label="doctype">
        <option value="">--</option><option value="pc">Plans - Construction</option></select></td></tr>
    </tbody></table>
    <a id="saveDoc" href="#" onclick="this.textContent='Saved';return false;">Save</a>
    ${continueLink("documents", `/oregon/Cap/CapDetail.aspx?step=review&j=${j}`)}
    <script>
     function _openUp(e){ e.preventDefault();
       var f=document.createElement('iframe'); f.name='ACADialogFrame';
       f.src='/oregon/Cap/UploadDialog.aspx'; f.style.width='400px'; f.style.height='200px';
       document.getElementById('dlgHost').appendChild(f); return false; }
    </script>`);
}

function uploadDialog() {
  return page("Upload", `
    <h3>File Upload</h3>
    <a href="#" onclick="document.getElementById('fi').style.display='block';return false;">Add</a>
    <input type="file" id="fi" style="display:none">
    <a href="#" onclick="this.textContent='Uploaded';return false;">Continue</a>`);
}

function review() {
  // Review page: has a final "Submit Application" button stopAtReview must DETECT but NEVER click.
  return page("Review", `
    <h2>Review Application</h2>
    <p>Please review all information before submitting.</p>
    <a id="submitApp" href="/oregon/Cap/SUBMITTED.aspx">Submit Application</a>`);
}

// ── route handler: dispatch by pathname ─────────────────────────────────────
function htmlFor(pathname: string, search: string): string | null {
  const j = new URLSearchParams(search).get("j") || "city";
  if (pathname.endsWith("/CapApplyDisclaimer.aspx")) return disclaimer();
  if (pathname.endsWith("/WorkLocation.aspx")) return workLocation();
  if (pathname.endsWith("/WorkLocationResults.aspx")) return workLocationResults();
  if (pathname.endsWith("/CapApplyType.aspx")) return appType(j);
  if (pathname.endsWith("/ContactDialog.aspx")) return contactDialog();
  if (pathname.endsWith("/UploadDialog.aspx")) return uploadDialog();
  if (pathname.endsWith("/CapDetail.aspx")) {
    const step = new URLSearchParams(search).get("step") || "parcel";
    if (step === "parcel") return parcelConfirm(j);
    if (step === "owner") return ownerConfirm(j);
    if (step === "projectinfo") return projectInfo(j);
    if (step === "contacts") return contacts(j);
    if (step === "construction") return j === "county" ? constructionElectrical(j) : constructionStructural(j);
    if (step === "documents") return documents(j);
    if (step === "review") return review();
  }
  if (pathname.endsWith("/SUBMITTED.aspx")) { submitViolation = true; return page("SUBMITTED", "<h1>SUBMITTED</h1>"); }
  return null;
}

// ── run one discipline end-to-end ───────────────────────────────────────────
async function runDiscipline(permitType: "structural" | "electrical", tmpFile: string) {
  const label = permitType.toUpperCase();
  console.log(`\n──────── Accela ${label} (${permitType === "electrical" ? "county" : "city"}) ────────`);
  // reset per-run state
  for (const k of Object.keys(recorded)) delete recorded[k];
  submitViolation = false;

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext();
  context.setDefaultTimeout(6000);

  await context.route(`**://${HOST}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.endsWith("/mock/record")) {
      try {
        const body = JSON.parse(req.postData() || "{}");
        recorded[body.step] = body.fields;
      } catch { /* ignore */ }
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
    const html = htmlFor(url.pathname, url.search);
    if (html == null) return route.fulfill({ status: 200, contentType: "text/html", body: page("blank", "") });
    // small delay so waitForLoadState('networkidle') is meaningful
    await new Promise((r) => setTimeout(r, 60));
    return route.fulfill({ status: 200, contentType: "text/html", body: html });
  });

  const mockPage = await context.newPage();
  // Land the page somewhere on-host first (login is bypassed for the mock).
  await mockPage.goto(`https://${HOST}/oregon/Default.aspx`);

  const adapter = new OregonEPermittingAdapter();
  // Inject the route-intercepted page + opened handle to bypass login (mirrors how
  // the live adapter holds these after login()). eslint-disable for the test-only cast.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (adapter as any).page = mockPage;
  (adapter as any).opened = { browser, context, page: mockPage };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const proj: ProjectRecord = { ...FIXTURE, permitType };

  // ── openSubmission ──
  const open = await adapter.openSubmission(proj);
  check(`${label}: openSubmission ok`, open.ok, open.message);
  check(`${label}: discipline routed = ${permitType}`, open.data?.permitDiscipline === permitType, String(open.data?.permitDiscipline));
  check(`${label}: jurisdiction row = ${permitType === "electrical" ? "county" : "city"}`,
    (recorded["apptype"]?.j) === (permitType === "electrical" ? "county" : "city"),
    `picked j=${recorded["apptype"]?.j}`);
  check(`${label}: correct app-type checkbox`,
    permitType === "electrical" ? recorded["apptype"]?.elec === true && recorded["apptype"]?.struct !== true
                                 : recorded["apptype"]?.struct === true && recorded["apptype"]?.elec !== true,
    `struct=${recorded["apptype"]?.struct} elec=${recorded["apptype"]?.elec}`);

  // ── fillApplication ──
  const fill = await adapter.fillApplication(proj);
  check(`${label}: fillApplication ok`, fill.ok, fill.message);
  const rec = (k: string): Record<string, unknown> => recorded[k] ?? {};
  const pinfo = rec("projectinfo");
  check(`${label}: Job Value filled`, pinfo["Job Value($):"] === FIXTURE.parserSnapshot.jobValue, `="${pinfo["Job Value($):"]}"`);
  check(`${label}: Project Name filled`, String(pinfo["Project Name"] || "").includes(FIXTURE.homeownerName), `="${pinfo["Project Name"]}"`);
  check(`${label}: Description of Work mentions photovoltaic`,
    /photovoltaic|solar/i.test(String(pinfo["Description of Work"] || "")), `len=${String(pinfo["Description of Work"]||"").length}`);
  const constr = rec("construction");
  check(`${label}: Construction category = Other (→Solar)`, constr["othercat"] === "Solar", `othercat="${constr["othercat"]}"`);
  if (permitType === "electrical") {
    check(`${label}: kVA tier 5.01–15 set to 1 (5.28 kW)`, constr["kva15"] === "1" && !constr["kva5"] && !constr["kva25"],
      `kva5=${constr["kva5"]} kva15=${constr["kva15"]} kva25=${constr["kva25"]}`);
    check(`${label}: Type of Work = New`, constr["tow"] === "new", `tow=${constr["tow"]}`);
  } else {
    check(`${label}: Building dims zeroed`, constr["bh"] === "0" && constr["nos"] === "0" && constr["nba"] === "0" && constr["eba"] === "0",
      `bh=${constr["bh"]} nos=${constr["nos"]} nba=${constr["nba"]} eba=${constr["eba"]}`);
    check(`${label}: Type of Work = Alteration/Addition`, ["alt", "add"].includes(String(constr["tow"])), `tow=${constr["tow"]}`);
  }
  check(`${label}: contact added from account`, fill.data?.contactAdded === true, `contactAdded=${fill.data?.contactAdded}`);

  // ── uploadFiles (best-effort; faithful nested-iframe dialog) ──
  const up = await adapter.uploadFiles(proj, [tmpFile]);
  check(`${label}: uploadFiles returned ok`, up.ok, up.message);

  // ── stopAtReview (must reach review + DETECT submit but NEVER click it) ──
  const stop = await adapter.stopAtReview(proj);
  check(`${label}: stopAtReview ok`, stop.ok, stop.message?.slice(0, 60));
  check(`${label}: reached review page`, stop.data?.reviewReached === true, `url=${stop.data?.portalReviewUrl}`);
  check(`${label}: SAFETY — final submit NEVER clicked`, submitViolation === false, submitViolation ? "VIOLATION: submit URL was hit" : "submit untouched");

  await browser.close();
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  // create a tiny sample upload file in the OS temp dir (never the repo)
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "accela-stress-")), "sample-sld.pdf");
  fs.writeFileSync(tmpFile, "%PDF-1.4 mock sld\n");

  console.log("Fixture:", FIXTURE.homeownerName, "|", FIXTURE.projectAddress, "| AHJ:", FIXTURE.ahj);
  await runDiscipline("structural", tmpFile);
  await runDiscipline("electrical", tmpFile);

  console.log("\n════════════════ ACCELA SUMMARY ════════════════");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`);
  console.log(`\n${failed.length === 0 ? "✅ ALL PASS" : "❌ FAILURES"}: ${passed}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
