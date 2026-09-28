// ONE CONTACT, ONE IDENTITY — the learner's Accela contact pass and its dialog guard, in real Chromium.
//
// Live City of Corvallis (Accela) electrical learn, 2026-09-28. The Applicant's Contact Information
// dialog asks ONE "Full Name" box and a "Name of Business" box (txtAppFullName /
// txtAppOrganizationName), not First/Last. The pass typed no name, the dialog refused its save, the
// read-back called that "ACA may have substituted an account contact", the planner then opened
// Select from Account, and the dialog went in with the HOMEOWNER's full name, mailing address and
// e-mail (the account contact's prefill) beside the COMPANY's business name and phone.
//
// The fixture is that portal's shape with fictional people: the section markup (ACA_TabRow h1 +
// ACA_Section_Instruction, the UpdatePanel with Select from Account / Add New), the dialog in the
// ACADialogFrame iframe with Corvallis's own control ids, a dialog that REFUSES a save without a
// Full Name, an account contact that prefills the dialog, and an optional substitution mode where
// the portal attaches the account's contact instead of the one typed.
//
//   MUST PASS
//     A. The pass fills the Applicant section's dialog (Full Name, Name of Business, address,
//        e-mail, phone) from the COMPANY's identity, every step BOUND to an installer key, and the
//        section reads back as that identity.
//     B. A save the dialog REFUSES is reported as refused (its own message), rolled back — never
//        read as "substituted".
//     C. When the portal attaches the ACCOUNT's contact instead, the pass EDITS it to the identity.
//     D. Corvallis Step 4 by HEADING: Licensed Professional (a look-up) is not the pass's,
//        Inspection Contact 1 is the company's, the optional second Inspection Contact stays empty.
//     E. The GUARD: the account contact's prefill (the homeowner) plus a planner fill bound to
//        homeownerEmail in the APPLICANT dialog are corrected before its Continue — every box the
//        company's, every step bound to an installer key; the saved section shows no homeowner value.
//     F. An OWNER dialog prefilled with the company's values gets the owner's, and its business box
//        (the company's name) is cleared.
//   MUST EXCLUDE
//     G. A dialog whose section names no identity is left exactly as filled.
//
//   npx tsx portal-bot/src/adapters/contactIdentity.dom.smoke.ts
import "../smokeArtifactDirs"; // artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { RecipeStep } from "../../../shared/src/types";
import { planContactSections, contactKeyRole } from "../../../shared/src/contactRoles";
import { AutoLearnAdapter, EXTRACT_SEL, toExtractedField, type ContactIdentity, type ExtractedField, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Fictional identities (never a real customer or company).
const COMPANY: ContactIdentity = {
  fullName: "Casey Contact", companyName: "Fernhollow Solar LLC", firstName: "Casey", lastName: "Contact",
  email: "permits@fernhollow.example", phone: "(555) 010-0100", street: "1 Industry Way", city: "Springfield", state: "WA", zip: "98683",
};
const OWNER: ContactIdentity = {
  fullName: "Robin Resident", firstName: "Robin", lastName: "Resident", email: "robin@example.com",
  phone: "(555) 010-0199", street: "9 Elm St", city: "Fernhollow", state: "OR", zip: "97330",
};
// What the ACCOUNT's saved contact prefills (the live shape: the homeowner's person, the company's business).
const ACCOUNT = { full: "Robin Resident", org: "Fernhollow Solar LLC", street: "9 Elm St", city: "Fernhollow", state: "OR", zip: "97330", email: "robin@example.com", phone: "" };
// The account contact ACA substitutes in mode C (someone else at the company).
const PERMIT_TECH = { full: "Pat Permittech", org: "Fernhollow Solar LLC", street: "1 Industry Way", city: "Springfield", state: "WA", zip: "98683", email: "tech@fernhollow.example", phone: "555-010-0111" };

const P = "ctl00_phPopup_ucContactInfo_";
const section = (key: string, heading: string, instruction: string, opts: { lookup?: boolean } = {}): string => `
<a name="${key}" class="SectionTextDecoration">&nbsp;</a>
<div>
  <div class="ACA_TabRow"><div class="ACA_Title_Bar"><h1><span>${heading}</span></h1></div>
    <div class="ACA_Section_Instruction">${instruction}</div></div>
  <div id="ctl00_PlaceHolderMain_UpdatePanel${key}">
    <div id="list_${key}"></div>
    ${opts.lookup
      ? `<a id="ctl00_PlaceHolderMain_${key}Edit_btnLookUp" href="javascript:void(0)"><span>Look Up</span></a>`
      : `<ul id="btns_${key}">
      <li><a id="ctl00_PlaceHolderMain_${key}Edit_btnSelectFromAccount" href="javascript:void(0)" onclick="openDlg('${key}','account')"><span>Select from Account</span></a></li>
      <li><a id="ctl00_PlaceHolderMain_${key}Edit_btnAddNew" href="javascript:void(0)" onclick="openDlg('${key}','new')"><span>Add New</span></a></li>
    </ul>`}
  </div>
</div>`;
const APPLICANT_TEXT = "The applicant is the responsible party for this permit and will receive permit correspondence by email. You may add one contact below. To add additional contacts, please call or email us after submitting your application.";
const shell = (title: string, body: string): string => `<!doctype html><html><head><title>City of Fernhollow - Permit System</title></head><body>
<div class="breadcrump-pagetitle">${title}</div>
<form id="aspnetForm" onsubmit="return false">${body}
<a id="ctl00_PlaceHolderMain_actionBarBottom_btnContinue" href="javascript:void(0)" class="ACA_LgButton">Continue Application »</a>
</form>
<div id="dlg" style="display:none;position:fixed;left:30px;top:30px;width:640px;height:520px;background:#fff;border:1px solid #333">
  <iframe name="ACADialogFrame" id="ACADialogFrame" style="width:100%;height:100%;border:0"></iframe>
</div>
<script>
  window.__contacts = {};
  window.__substitute = false;
  function openDlg(sec, mode) {
    document.getElementById('dlg').style.display = 'block';
    document.querySelector('iframe[name=ACADialogFrame]').src = '/dialog?sec=' + sec + '&mode=' + mode + '&t=' + Date.now();
  }
  function saved(sec, data) {
    window.__contacts[sec] = data;
    var list = document.getElementById('list_' + sec);
    list.innerHTML = '<div class="card">Contact added successfully. <span class="n">' + data.full + '</span> <span class="o">' + data.org + '</span> '
      + data.street + ' ' + data.city + ' ' + data.state + ' ' + data.zip + ' ' + data.phone + ' ' + data.email
      + ' <a id="ctl00_PlaceHolderMain_' + sec + 'Edit_btnEdit" href="javascript:void(0)" onclick="openDlg(\\'' + sec + '\\',\\'edit\\')">Edit</a>'
      + ' <a id="ctl00_PlaceHolderMain_' + sec + 'Edit_btnRemove" href="javascript:void(0)">Remove</a></div>';
    var btns = document.getElementById('btns_' + sec);
    if (btns) btns.style.display = 'none';
    document.getElementById('dlg').style.display = 'none';
  }
</script></body></html>`;
const STEP2 = shell("Step 2 : Applicant Info &gt; Applicant Info", section("Applicant_9479", "Applicant", APPLICANT_TEXT));
const STEP4 = shell("Step 4 : Contact Info &gt; Contact Info",
  section("License_9482", "Licensed Professional", "To find a Contractor in our database, click the Look Up button and enter the search criteria.", { lookup: true })
  + section("Contact1_9483", "Inspection Contact", "Inspection contacts receive all inspection results via email. To add a contact, click Select from Account or Add New.")
  + section("Contact2_9484", "Inspection Contact", "Optional additional inspection contact. To add a contact, click Select from Account or Add New."));
const OWNER_PAGE = shell("Step 1 : Site Info &gt; Owner", section("Owner_9477", "Owner", "The property owner."));
const NOBODY_PAGE = shell("Step 3 : Other", section("Contact3_9490", "Contact Information", "Add a contact."));

const dialog = (sec: string, mode: string): string => `<!doctype html><html><head><title>Contact Information</title></head><body>
<h1>Contact Information</h1>
<table>
<tr><td><label for="${P}ddlContactType">Type:</label></td><td><select id="${P}ddlContactType" name="ctl00$phPopup$ucContactInfo$ddlContactType"><option value="">--Select--</option><option>Applicant</option><option>Inspection Contact</option><option>Owner</option></select></td></tr>
<tr><td><label for="${P}txtAppFullName">Full Name:</label></td><td><input id="${P}txtAppFullName" name="ctl00$phPopup$ucContactInfo$txtAppFullName"></td></tr>
<tr><td><label for="${P}txtAppOrganizationName">Name of Business:</label></td><td><input id="${P}txtAppOrganizationName" name="ctl00$phPopup$ucContactInfo$txtAppOrganizationName"></td></tr>
<tr><td><label for="${P}txtAppStreetAdd1">Mailing Address:</label></td><td><input id="${P}txtAppStreetAdd1" name="ctl00$phPopup$ucContactInfo$txtAppStreetAdd1"></td></tr>
<tr><td><label for="${P}txtAppCity">City:</label></td><td><input id="${P}txtAppCity" name="ctl00$phPopup$ucContactInfo$txtAppCity"></td></tr>
<tr><td><label for="${P}txtAppState_State1">State:</label></td><td><select id="${P}txtAppState_State1" name="ctl00$phPopup$ucContactInfo$txtAppState$State1"><option value="">--Select--</option><option>OR</option><option>WA</option><option>UT</option></select></td></tr>
<tr><td><label for="${P}txtAppZipApplicant">Zip:</label></td><td><input id="${P}txtAppZipApplicant" name="ctl00$phPopup$ucContactInfo$txtAppZipApplicant"></td></tr>
<tr><td><label for="${P}txtAppEmail">E-mail:</label></td><td><input id="${P}txtAppEmail" name="ctl00$phPopup$ucContactInfo$txtAppEmail"></td></tr>
<tr><td><label for="${P}txtAppPhone3">Contact Phone:</label></td><td><input id="${P}txtAppPhone3" name="ctl00$phPopup$ucContactInfo$txtAppPhone3"></td></tr>
</table>
<span id="err" class="ACA_Error_Label" style="display:none;color:red"></span>
<a id="btnContinue" role="button" href="javascript:void(0)" onclick="save()">Continue</a>
<a id="btnCancel" role="button" href="javascript:void(0)" onclick="parent.document.getElementById('dlg').style.display='none'">Cancel</a>
<script>
  var sec = ${JSON.stringify(sec)}, mode = ${JSON.stringify(mode)};
  var ids = { full: '${P}txtAppFullName', org: '${P}txtAppOrganizationName', street: '${P}txtAppStreetAdd1', city: '${P}txtAppCity', state: '${P}txtAppState_State1', zip: '${P}txtAppZipApplicant', email: '${P}txtAppEmail', phone: '${P}txtAppPhone3' };
  var pre = mode === 'account' ? ${JSON.stringify(ACCOUNT)} : mode === 'edit' ? (parent.__contacts[sec] || null) : null;
  if (pre) for (var k in ids) document.getElementById(ids[k]).value = pre[k] || '';
  function save() {
    var data = {};
    for (var k in ids) data[k] = document.getElementById(ids[k]).value;
    if (!data.full) { var e = document.getElementById('err'); e.style.display = 'inline'; e.textContent = 'Full Name: This field is required.'; return; }
    if (mode === 'new' && parent.__substitute) data = ${JSON.stringify(PERMIT_TECH)};
    parent.saved(sec, data);
  }
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  res.writeHead(200, { "content-type": "text/html" });
  if (url.pathname === "/dialog") return void res.end(dialog(url.searchParams.get("sec") || "", url.searchParams.get("mode") || "new"));
  const page = url.pathname.includes("Step4") ? STEP4 : url.pathname.includes("Owner") ? OWNER_PAGE : url.pathname.includes("Other") ? NOBODY_PAGE : STEP2;
  res.end(page);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page: Page = await context.newPage();

type Section = { key: number; heading: string; instruction: string; text: string; addNewId: string; selectId: string; editId: string; hasAddNew: boolean; hasEdit: boolean };
type Internals = {
  page: unknown;
  acaContactSectionsOnPage(): Promise<Section[] | null>;
  accelaAddContactPass(steps: RecipeStep[], target: unknown, used?: string[]): Promise<{ ok: boolean; usedId: string }>;
  enforceContactDialogIdentity(fields: ExtractedField[], steps: RecipeStep[], pageCount: number, url: string, frame: string): Promise<number>;
  noteContactClick(field: ExtractedField, url: string): void;
  extractAllFrames(sel: string): Promise<Parameters<typeof toExtractedField>[0][]>;
  closeAcaDialog(): Promise<boolean>;
  debug: { event(e: Record<string, unknown>): void } | null;
};
const planner: LearnPlanner = async () => ({ fills: [], atReview: true });
const events: Array<Record<string, unknown>> = [];
const makeAdapter = (): Internals => {
  const a = new AutoLearnAdapter("Contact Identity Fixture", planner, { maxPages: 1, policyProfile: "permit_standard", contactIdentity: COMPANY, siteContactIdentity: OWNER });
  const x = a as unknown as Internals;
  x.page = page;
  const orig = x.debug;
  x.debug = { event: (e) => { events.push(e); try { orig?.event(e); } catch { /* diagnostics */ } } };
  return x;
};
const targetOf = (s: Section, role: "company" | "owner") => ({ role, heading: s.heading, addNewId: s.addNewId, editId: s.editId, selectId: s.selectId, sectionKey: s.key, holds: s.hasEdit ? s.text : "" });
const cardText = async (sec: string): Promise<string> => page.locator(`#list_${sec}`).innerText().catch(() => "");
const ownerKeys = (steps: RecipeStep[]) => steps.filter((s) => contactKeyRole(s.field)?.role === "owner").map((s) => `${s.note} -> ${s.field}`);
const companyKeys = (steps: RecipeStep[]) => steps.filter((s) => contactKeyRole(s.field)?.role === "company").map((s) => `${s.note} -> ${s.field}`);
const dlgValue = async (id: string): Promise<string> => page.frameLocator('iframe[name="ACADialogFrame"]').locator(`#${P}${id}`).inputValue({ timeout: 3000 }).catch(() => "?");

// ── A. The pass: Corvallis's Full Name / Name of Business dialog, company identity ──────────
console.log("\nA. MUST PASS: the Applicant section is filled from the company's identity (Full Name + Name of Business)");
{
  await page.goto(`${base}/Cap/CapEdit.aspx`);
  const a = makeAdapter();
  const sections = await a.acaContactSectionsOnPage();
  const plan = sections ? planContactSections(sections.map((s) => ({ heading: s.heading, text: s.instruction, canAdd: s.hasAddNew || s.hasEdit }))) : [];
  check("A: the Applicant section is read by its HEADING, with its instruction", !!sections && sections.length === 1 && sections[0].heading === "Applicant" && /additional contacts/.test(sections[0].instruction), JSON.stringify(sections));
  check("A: the plan gives it the company (its 'To add additional contacts' is not 'optional')", plan[0]?.role === "company", JSON.stringify(plan));
  const steps: RecipeStep[] = [];
  const res = sections ? await a.accelaAddContactPass(steps, targetOf(sections[0], "company"), []) : { ok: false, usedId: "" };
  const card = await cardText("Applicant_9479");
  check("A: the pass reports success and the section reads back as the company's contact", res.ok && /Casey Contact/.test(card) && /Fernhollow Solar LLC/.test(card) && /permits@fernhollow\.example/.test(card), `ok=${res.ok} card=${card}`);
  check("A: every recorded box is BOUND to an installer key (full name -> installerContactName, business -> installerCompanyName)",
    steps.some((s) => s.field === "installerContactName") && steps.some((s) => s.field === "installerCompanyName") && steps.some((s) => s.field === "installerEmail") && ownerKeys(steps).length === 0,
    JSON.stringify(steps.map((s) => [s.note, s.field])));
  check("A: the Add New step names the SECTION's own control id (a page with two sections replays the right one)",
    steps.some((s) => s.action === "click" && /Applicant_9479Edit_btnAddNew/.test(String(s.selector?.css ?? ""))), JSON.stringify(steps.filter((s) => s.action === "click").map((s) => s.selector)));
  check("A MUST EXCLUDE: no homeowner value reached the Applicant section", !/Robin|Resident|robin@example\.com|9 Elm/.test(card), card);
}

// ── B. A save the dialog refuses is REFUSED, not "substituted" ───────────────────────────────
console.log("\nB. MUST PASS: a save the dialog refuses (no Full Name) is reported as refused and rolled back");
{
  await page.goto(`${base}/Cap/CapEdit.aspx`);
  const a = makeAdapter();
  // An identity with no name at all: the dialog's Full Name stays empty.
  (a as unknown as { contactIdentity: ContactIdentity }).contactIdentity = { email: COMPANY.email, street: COMPANY.street, city: COMPANY.city, state: COMPANY.state, zip: COMPANY.zip };
  events.length = 0;
  const sections = await a.acaContactSectionsOnPage();
  const steps: RecipeStep[] = [];
  const res = sections ? await a.accelaAddContactPass(steps, targetOf(sections[0], "company"), []) : { ok: false, usedId: "" };
  const refused = events.find((e) => e.type === "contact_dialog_refused");
  check("B: the refusal is reported with the dialog's own message", !res.ok && !!refused && /Full Name: This field is required/.test(JSON.stringify(refused)), JSON.stringify(events.filter((e) => /contact_/.test(String(e.type)))));
  check("B: never misread as a substitution", !events.some((e) => /substitut/.test(JSON.stringify(e))));
  check("B: its steps are rolled back", steps.length === 0, JSON.stringify(steps.map((s) => s.note)));
}

// ── C. The portal attaches the ACCOUNT's contact: the pass edits it to the identity ───────────
console.log("\nC. MUST PASS: an account contact the portal attaches instead is EDITED to the company's identity");
{
  await page.goto(`${base}/Cap/CapEdit.aspx`);
  await page.evaluate(() => { (window as unknown as { __substitute: boolean }).__substitute = true; });
  const a = makeAdapter();
  events.length = 0;
  const sections = await a.acaContactSectionsOnPage();
  const steps: RecipeStep[] = [];
  const res = sections ? await a.accelaAddContactPass(steps, targetOf(sections[0], "company"), []) : { ok: false, usedId: "" };
  const card = await cardText("Applicant_9479");
  check("C: the substituted account contact is detected and EDITED — the section now reads as the company's contact",
    res.ok && /Casey Contact/.test(card) && !/Pat Permittech/.test(card) && events.some((e) => e.type === "contact_substituted"), `ok=${res.ok} card=${card}`);
  check("C: the Edit is recorded (optional) with its own id, and the re-fill is bound to installer keys",
    steps.some((s) => s.action === "click" && s.optional === true && /btnEdit/.test(String(s.selector?.css ?? ""))) && ownerKeys(steps).length === 0,
    JSON.stringify(steps.map((s) => [s.action, s.note, s.field, s.selector?.css])));
}

// ── D. Corvallis Step 4, by heading ──────────────────────────────────────────────────────────
console.log("\nD. MUST PASS: Step 4 by HEADING — look-up left alone, Inspection Contact 1 = company, the optional one empty");
{
  await page.goto(`${base}/Cap/Step4/CapEdit.aspx`);
  const a = makeAdapter();
  const sections = await a.acaContactSectionsOnPage();
  const plan = sections ? planContactSections(sections.map((s) => ({ heading: s.heading, text: s.instruction, canAdd: s.hasAddNew || s.hasEdit }))) : [];
  check("D: three sections read, in page order, by heading", !!sections && sections.map((s) => s.heading).join("|") === "Licensed Professional|Inspection Contact|Inspection Contact", JSON.stringify(sections?.map((s) => s.heading)));
  check("D: Licensed Professional is a look-up (not the pass's), Inspection Contact 1 the company, the optional one empty",
    plan[0]?.role === null && /look-up/.test(plan[0]?.why ?? "") && plan[1]?.role === "company" && plan[2]?.role === null && /optional/.test(plan[2]?.why ?? ""), JSON.stringify(plan));
  const steps: RecipeStep[] = [];
  const res = sections ? await a.accelaAddContactPass(steps, targetOf(sections[1], "company"), []) : { ok: false, usedId: "" };
  check("D: Inspection Contact 1 is filled with the company's contact", res.ok && /Casey Contact/.test(await cardText("Contact1_9483")), await cardText("Contact1_9483"));
  check("D MUST EXCLUDE: the optional Inspection Contact stays EMPTY (never the homeowner)", (await cardText("Contact2_9484")).trim() === "", await cardText("Contact2_9484"));
  check("D: its steps carry the section's own Add New id (Contact1), never Contact2's",
    steps.some((s) => /Contact1_9483Edit_btnAddNew/.test(String(s.selector?.css ?? ""))) && !JSON.stringify(steps).includes("Contact2_9484"), JSON.stringify(steps.filter((s) => s.action === "click").map((s) => s.selector)));
}

// ── E. The guard: the Applicant dialog prefilled from the account (homeowner) + a planner fill ──
const fieldsNow = async (a: Internals): Promise<ExtractedField[]> => (await a.extractAllFrames(EXTRACT_SEL)).map(toExtractedField);
const openVia = async (a: Internals, key: string, mode: "account" | "new", url: string): Promise<void> => {
  // The planner's click on the section's opener (the guard learns whose dialog opens from it).
  const fields = await fieldsNow(a);
  const opener = fields.find((f) => (mode === "account" ? /select from account/i : /add new/i).test(String(f.label ?? "")) && String(f.fingerprint?.id ?? "").includes(key));
  if (opener) a.noteContactClick(opener, url);
  await page.evaluate(([k, m]) => (window as unknown as { openDlg: (s: string, m: string) => void }).openDlg(k, m), [key, mode]);
  await page.frameLocator('iframe[name="ACADialogFrame"]').locator(`#${P}txtAppFullName`).waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
};
console.log("\nE. MUST PASS: the guard makes the Applicant dialog ONE identity (the company's) before its Continue");
{
  const url = `${base}/Cap/CapEdit.aspx`;
  await page.goto(url);
  const a = makeAdapter();
  await openVia(a, "Applicant_9479", "account", url);
  const fields = await fieldsNow(a);
  const phoneField = fields.find((f) => /contact phone/i.test(String(f.label ?? "")) && f.selector?.frame);
  const emailField = fields.find((f) => /e-mail/i.test(String(f.label ?? "")) && f.selector?.frame);
  // What the planner did: the company's phone (bound), and — the mix — the homeowner's e-mail bound to homeownerEmail.
  const fr = page.frameLocator('iframe[name="ACADialogFrame"]');
  await fr.locator(`#${P}txtAppPhone3`).fill("555-010-0100");
  await fr.locator(`#${P}txtAppEmail`).fill(OWNER.email!);
  const steps: RecipeStep[] = [
    { action: "fill", phase: "fill", selector: phoneField!.selector, field: "installerPhone", note: "Contact Phone:" },
    { action: "fill", phase: "fill", selector: emailField!.selector, field: "homeownerEmail", note: "E-mail:" },
  ];
  check("E: fixture — the dialog opened with the homeowner's prefill (the live mix)", (await dlgValue("txtAppFullName")) === "Robin Resident" && (await dlgValue("txtAppEmail")) === OWNER.email, await dlgValue("txtAppFullName"));
  const fixed = await a.enforceContactDialogIdentity(fields, steps, 9, url, "ACADialogFrame");
  const values = { full: await dlgValue("txtAppFullName"), org: await dlgValue("txtAppOrganizationName"), street: await dlgValue("txtAppStreetAdd1"), city: await dlgValue("txtAppCity"), zip: await dlgValue("txtAppZipApplicant"), email: await dlgValue("txtAppEmail") };
  check("E: every box now holds the COMPANY's value", fixed >= 5 && values.full === "Casey Contact" && values.org === "Fernhollow Solar LLC" && values.street === "1 Industry Way" && values.city === "Springfield" && values.zip === "98683" && values.email === COMPANY.email, `fixed=${fixed} ${JSON.stringify(values)}`);
  check("E: the planner's homeownerEmail step is REPLACED by one bound to installerEmail; no step is bound to a homeowner key",
    ownerKeys(steps).length === 0 && steps.some((s) => s.field === "installerEmail") && steps.some((s) => s.field === "installerContactName") && steps.some((s) => s.field === "installerStreet"),
    JSON.stringify(steps.map((s) => [s.note, s.field])));
  await fr.locator("#btnContinue").click();
  await page.waitForTimeout(400);
  const card = await cardText("Applicant_9479");
  check("E: the saved Applicant shows the company's contact and NO homeowner value", /Casey Contact/.test(card) && !/Robin|Resident|robin@example\.com|9 Elm/.test(card), card);
}

// ── F. An Owner dialog never keeps company values ─────────────────────────────────────────────
console.log("\nF. MUST PASS: an OWNER dialog prefilled with the company's values gets the owner's; the business box is cleared");
{
  const url = `${base}/Cap/Owner/CapEdit.aspx`;
  await page.goto(url);
  const a = makeAdapter();
  await openVia(a, "Owner_9477", "new", url);
  const fr = page.frameLocator('iframe[name="ACADialogFrame"]');
  // The company's identity typed into the owner's dialog (the mirror-image mix).
  await fr.locator(`#${P}txtAppFullName`).fill(COMPANY.fullName!);
  await fr.locator(`#${P}txtAppOrganizationName`).fill(COMPANY.companyName!);
  await fr.locator(`#${P}txtAppEmail`).fill(COMPANY.email!);
  const fields = await fieldsNow(a);
  const steps: RecipeStep[] = [];
  await a.enforceContactDialogIdentity(fields, steps, 3, url, "ACADialogFrame");
  const values = { full: await dlgValue("txtAppFullName"), org: await dlgValue("txtAppOrganizationName"), email: await dlgValue("txtAppEmail"), street: await dlgValue("txtAppStreetAdd1") };
  check("F: the owner's name, e-mail and (site) address; the company's business name CLEARED",
    values.full === "Robin Resident" && values.email === OWNER.email && values.street === "9 Elm St" && values.org === "", JSON.stringify(values));
  check("F: no step is bound to an installer key", companyKeys(steps).length === 0 && steps.some((s) => s.field === "homeownerName"), JSON.stringify(steps.map((s) => [s.note, s.field, s.value])));
}

// ── G. MUST EXCLUDE: a dialog whose section names no identity is left alone ────────────────────
console.log("\nG. MUST EXCLUDE: a dialog whose section names no identity is left exactly as filled");
{
  const url = `${base}/Cap/Other/CapEdit.aspx`;
  await page.goto(url);
  const a = makeAdapter();
  await openVia(a, "Contact3_9490", "account", url);
  const fields = await fieldsNow(a);
  const steps: RecipeStep[] = [];
  events.length = 0;
  const fixed = await a.enforceContactDialogIdentity(fields, steps, 4, url, "ACADialogFrame");
  check("G: nothing corrected, nothing recorded, and the reason is said", fixed === 0 && steps.length === 0 && (await dlgValue("txtAppFullName")) === "Robin Resident" && events.some((e) => e.type === "contact_identity_unknown"),
    `fixed=${fixed} steps=${steps.length} full=${await dlgValue("txtAppFullName")}`);
}

await browser.close();
server.close();
if (failures) { console.error(`\ncontactIdentity DOM smoke: ${failures} check(s) FAILED`); process.exit(1); }
console.log("\ncontactIdentity DOM smoke: all checks passed (real Chromium)");
process.exit(0);
