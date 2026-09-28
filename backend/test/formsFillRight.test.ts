// FILL IT RIGHT (City of Waltham, MA — live 2026-09-28).
//
// The operator handed the product Waltham's Residential Application and got back: the homeowner's
// phone number in the authorized agent's EMAIL box, the client's Oregon CCB number in the
// Massachusetts construction-supervisor licence slot (with the org's signer printed as the licence
// holder), "I, <org signer>" declared above the HOMEOWNER's printed name under one signature, the
// estimated-cost table empty, no signature placements (the vision pass truncated at 4096 tokens),
// and the property blanks silently empty. The cause: the AcroForm mapper saw widget NAMES only, and
// the blank's auto-generated names are shifted onto neighbouring boxes.
//
// The fixture below is generic — a generated two-page blank whose widget names are SHIFTED against
// the captions printed under them — never Waltham's PDF, never a network fetch. The model is a LOCAL
// HTTP stub standing in for api.anthropic.com (ANTHROPIC_BASE_URL), so the request asserted is the
// one production would send and the response goes through llm.ts's real parsing.
//
//   npx tsx backend/test/formsFillRight.test.ts
import "./_isolate"; // FIRST: temp cwd, so filled/ and page-images never land in the repo
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { REPO } from "./_isolate";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forms-fill-right-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "portal-profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE"]) process.env[k] = "off";
process.env.DOCUMENT_FETCH_BROWSER = "0";
process.env.PORTAL_ALLOW_FINAL_SUBMIT = "false";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------------------------
// The model API stub: answers the AcroForm mapper and the vision pass by which prompt it was sent.
// ---------------------------------------------------------------------------------------------
interface Captured { path: string; body: Record<string, unknown> }
const captured: Captured[] = [];
let acroReply = "";
let visionReply = "";
function sse(text: string): string {
  const start = { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } };
  return [
    `event: message_start\ndata: ${JSON.stringify(start)}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
}
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* keep {} */ }
    captured.push({ path: req.url ?? "", body });
    if ((req.url ?? "").includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 1 })); return; }
    const isVision = JSON.stringify(body.system ?? "").includes("BLANK government permit form");
    const text = isVision ? visionReply : acroReply;
    if (body.stream === true) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(sse(text)); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_stub", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text, citations: null }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 40 } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const acroCalls = (): Captured[] => captured.filter((c) => !c.path.includes("count_tokens") && !JSON.stringify(c.body.system ?? "").includes("BLANK government permit form"));
const visionCalls = (): Captured[] => captured.filter((c) => JSON.stringify(c.body.system ?? "").includes("BLANK government permit form"));

const { openDatabase } = await import("../src/db");
const { createProject, getProjectDetail } = await import("../src/repository");
const { createClient } = await import("../src/clients");
const { ClaudeLLMProvider, FLAT_FORM_OVERLAY_MAX_TOKENS } = await import("../src/llm");
const { inspectPlacedFields, buildContext, fillLoadedForm, loadStoredTemplates, buildFilledFormsForProject, resolveSource } = await import("../src/ahjForms");
const { acquireFromBytes, buildFieldMapForPdf, fieldSourcesForState, remapStoredTemplate, storeAhjFormTemplate } = await import("../src/ahjFormAuto");
const { extractLabels } = await import("../src/formTextLayer");
const db = await openDatabase();
const provider = new ClaudeLLMProvider("sk-ant-stub-key");

// ---------------------------------------------------------------------------------------------
// THE FIXTURE: a caption-UNDER blank whose widget names are shifted, like Waltham's.
// ---------------------------------------------------------------------------------------------
const COST_ROWS = ["1 Building", "2 Electrical", "3 Plumbing", "4 Mechanical HVAC", "5 Fire Protection", "6 Total  12345"];
const COST_CAPTIONS = ["1. Building", "2. Electrical", "3. Plumbing", "4. Mechanical (HVAC)", "5. Fire Protection", "6. Total = (1+2+3+4+5)"];
const costName = (i: number): string => `Estimated Costs Dollars to be Completed by permit applicant${COST_ROWS[i]}`;

async function shiftedBlank(prefill: Record<string, string> = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font: PDFFont = await doc.embedFont(StandardFonts.Helvetica);
  const p0 = doc.addPage([612, 792]);
  const p1 = doc.addPage([612, 792]);
  const form = doc.getForm();
  const t = (page: PDFPage, s: string, x: number, y: number): void => page.drawText(s, { x, y, size: 9, font });
  const box = (page: PDFPage, name: string, x: number, y: number, w: number, h = 12): void => {
    const f = form.createTextField(name);
    f.addToPage(page, { x, y, width: w, height: h });
    if (prefill[name]) f.setText(prefill[name]);
  };
  const tick = (page: PDFPage, name: string, x: number, y: number): void => form.createCheckBox(name).addToPage(page, { x, y, width: 9, height: 9 });
  // Page 1 — owner, agent (captions printed UNDER each box).
  t(p0, "SECTION 2 - PROPERTY OWNERSHIP", 40, 750);
  box(p0, "Name Print", 40, 715, 250); t(p0, "Name (Print)", 42, 705);
  box(p0, "Address for Service", 320, 715, 250); t(p0, "Address for Service", 322, 705);
  box(p0, "undefined_3", 320, 685, 250); t(p0, "Email Address", 322, 675);
  t(p0, "Signature", 42, 671); t(p0, "Telephone", 230, 671);            // the owner's phone has NO box
  t(p0, "2.2 Authorized Agent", 42, 650);
  box(p0, "SECTION 3  CONSTRUCTION SERVICES", 40, 625, 250); t(p0, "Name (Print)", 42, 615);  // SHIFTED: the agent's name box
  box(p0, "Address", 320, 625, 250); t(p0, "Address", 322, 615);
  box(p0, "Telephone", 320, 595, 250); t(p0, "Email Address", 322, 585);                     // SHIFTED: the agent's EMAIL box
  t(p0, "Signature", 42, 591); t(p0, "Telephone", 230, 591);            // the agent's phone has NO box (just under the email box's line)
  box(p0, "Contact Email", 320, 555, 250); t(p0, "Telephone", 322, 545);                       // SHIFTED the other way: a PHONE box
  t(p0, "SECTION 3 - CONSTRUCTION SERVICES", 42, 520);
  t(p0, "3.1 Licensed Construction Supervisor:", 42, 505); t(p0, "Not Applicable", 402, 505); tick(p0, "Not Applicable", 470, 503);
  box(p0, "Licensed Construction Supervisor", 40, 480, 300); t(p0, "Licensed Construction Supervisor:", 42, 470);
  box(p0, "License Number", 400, 480, 160); t(p0, "License Number", 402, 470);
  box(p0, "Company Name", 40, 440, 300); t(p0, "Company Name", 42, 430);
  box(p0, "Registration Number", 400, 440, 160); t(p0, "Registration Number", 402, 430);
  // Page 2 — the WC attestation, the cost table, 7a / 7b, and widget-less printed blanks.
  t(p1, "SECTION 4 - WORKERS' COMPENSATION INSURANCE AFFIDAVIT", 42, 760);
  t(p1, "Signed Workers' Compensation Affidavit Attached", 42, 740);
  tick(p1, "Yes", 300, 738); t(p1, "Yes", 312, 740);
  tick(p1, "No", 360, 738); t(p1, "No", 372, 740);
  t(p1, "SECTION 6 - ESTIMATED CONSTRUCTION COSTS", 42, 715);
  COST_ROWS.forEach((_, i) => { const y = 700 - i * 15; t(p1, COST_CAPTIONS[i], 42, y); box(p1, costName(i), 170, y - 4, 180, 14); });
  t(p1, "SECTION 7a - OWNER AUTHORIZATION", 42, 590);
  t(p1, "I,", 42, 560); box(p1, "hereby authorize", 50, 556, 300, 13); t(p1, ", as Owner of the subject property", 360, 557);
  t(p1, "hereby authorize", 42, 541); box(p1, "my behalf in all matters", 120, 538, 300, 12); t(p1, "to act on", 430, 541);
  t(p1, "Signature of Owner", 42, 505); t(p1, "Date", 400, 505);
  t(p1, "SECTION 7b - OWNER/AUTHORIZED AGENT DECLARATION", 42, 480);
  t(p1, "I,", 42, 460); box(p1, "NAME", 50, 456, 300, 13); t(p1, ", as Owner/Authorized Agent", 360, 457);
  t(p1, "Hereby declare that the statements and information are true.", 42, 440);
  t(p1, "Signed under the pains and penalties of perjury.", 42, 428);
  box(p1, "Print Name", 42, 400, 400, 13); t(p1, "Print Name", 42, 388);
  t(p1, "Signature of Owner/Agent", 42, 360); t(p1, "Date", 400, 360);
  t(p1, "SECTION 1 - SITE INFORMATION", 42, 340);
  p1.drawRectangle({ x: 40, y: 310, width: 200, height: 14, borderWidth: 0.5 }); t(p1, "Zoning District", 42, 300);   // printed blank, NO widget
  p1.drawRectangle({ x: 320, y: 310, width: 200, height: 14, borderWidth: 0.5 }); t(p1, "Map Number", 322, 300);     // printed blank, NO widget
  return doc.save();
}
const BLANK = await shiftedBlank();

// ---------------------------------------------------------------------------------------------
// The job: a Massachusetts filing by a client whose only licence on file is an Oregon CCB.
// ---------------------------------------------------------------------------------------------
const orOnlyClient = createClient(db, {
  companyName: "Shift Solar LLC", legalBusinessName: "Shift Solar LLC", ccbLicenseNumber: "223690",
  electricalLicenseNumber: "", businessEmail: "ops@shiftsolar.test", businessPhone: "(503) 555-0100", businessAddress: "9 Industry Way",
});
const maClient = createClient(db, {
  companyName: "Bay State Solar LLC", legalBusinessName: "Bay State Solar LLC", ccbLicenseNumber: "223690",
  businessEmail: "ops@baystate.test", businessPhone: "(617) 555-0100",
  stateLicenses: [{ state: "MA", kind: "construction_supervisor", number: "CS-123456" }],
});
const HOMEOWNER = "Zelda Quintrell";
const HOMEOWNER_PHONE = "5415550123";
const HOMEOWNER_EMAIL = "zelda.quintrell@example.test";
const ACCOUNT = "ACCT99887766";
const mkProject = (state: string, clientId: string, extra: Record<string, string> = {}) => createProject(db, {
  clientId, owner: HOMEOWNER, street: "12 Elm St", city: state === "OR" ? "Coos Bay" : "Shiftham", state, zip: state === "OR" ? "97420" : "02451",
  ahj: state === "OR" ? "City of Shiftville OR" : "City of Shiftville", utility: "Test Electric", account: ACCOUNT, meter: "M-4455",
  dcKw: "7.2", acKw: "6.0", homeownerPhone: HOMEOWNER_PHONE, homeownerEmail: HOMEOWNER_EMAIL, jobValue: "19565", parcelNumber: "R0220110013",
  ...extra,
}).project;
const maJob = mkProject("MA", orOnlyClient.id);
const orJob = mkProject("OR", orOnlyClient.id);
const maLicensedJob = mkProject("MA", maClient.id);
const SIGNER = "Avery Signer";
const ctxFor = (project: typeof maJob) => {
  const ctx = buildContext(db, getProjectDetail(db, project.id).project);
  ctx.signatures = { applicant: { bytes: new Uint8Array(), mime: "image/png", widthPx: 1, heightPx: 1, name: SIGNER } };
  return ctx;
};
const outPath = (name: string): string => path.join(tmpDir, `${name}.pdf`);
const readFields = async (file: string) => (await PDFDocument.load(fs.readFileSync(file))).getForm();
const textOf = (form: Awaited<ReturnType<typeof readFields>>, name: string): string => form.getTextField(name).getText() ?? "";

// =============================================================================================
console.log("\nB1. CAPTIONS — every widget carries the text printed around it");
const inspected = await inspectPlacedFields(BLANK);
const field = (name: string) => inspected.fields.find((f) => f.name === name)!;
await check("the form's caption side is calibrated from the names that agree with it: BELOW", () => {
  assert.equal(inspected.captionSide, "below");
});
await check('MUST-PASS: the widget NAMED "Telephone" is captioned "Email Address" (the agent\'s email box)', () => {
  assert.equal(field("Telephone").caption, "Email Address");
  assert.equal(field("Telephone").page, 0);
});
await check('MUST-EXCLUDE: the widget-less "Telephone" text just under that box\'s line is not taken as its caption', () => {
  assert.notEqual(field("Telephone").caption, "Telephone");
  assert.equal(field("Telephone").captions?.left, undefined);
});
await check('a box named "Contact Email" is captioned "Telephone"; the declarant\'s left caption is "I,"; a cost row takes its row label', () => {
  assert.equal(field("Contact Email").caption, "Telephone");
  assert.equal(field("NAME").captions?.left, "I,");
  assert.equal(field(costName(5)).caption, "6. Total = (1+2+3+4+5)");
});

// =============================================================================================
console.log("\nB1 + rule 2. THE MAPPER PAYLOAD — captions on the wire, no project value");
acroReply = JSON.stringify({
  textFields: [
    { name: "Name Print", source: "project.homeownerName" },
    { name: "Telephone", source: "client.installerEmail" },
    ...COST_ROWS.map((_, i) => ({ name: costName(i), source: "computed.estimatedJobValue" })),
    { name: "Licensed Construction Supervisor", source: "computed.applicantSignerName" },
    { name: "License Number", source: "client.ccbLicenseNumber" },
    { name: "NAME", source: "computed.applicantSignerName" },
    { name: "Print Name", source: "project.homeownerName" },
    { name: "hereby authorize", source: "project.homeownerName" },
    { name: "Registration Number", source: "operator:Registration Number" },
  ],
  checkboxes: [{ name: "Yes", source: "lit:X", equals: null }, { name: "Not Applicable", source: "lit:X", equals: null }],
  notes: "stub mapper",
});
// A blank uploaded HALF-FILLED with this job's own values: they are field VALUES and must never ride
// to the model (hard rule 2: the mapper gets names and captions).
const halfFilled = await shiftedBlank({ Telephone: HOMEOWNER_PHONE, "Name Print": HOMEOWNER, undefined_3: HOMEOWNER_EMAIL });
captured.length = 0;
const built = await buildFieldMapForPdf(provider, { ahj: "City of Shiftville", state: "MA", formName: "Residential Application", bytes: halfFilled });
const acroBody = JSON.stringify(acroCalls()[0]?.body ?? {});
await check("captions reach the mapper payload: the shifted \"Telephone\" box goes out with its printed caption", () => {
  assert.ok(acroBody.includes('Telephone | PDFTextField | p1 | caption: \\"Email Address\\"'), acroBody.slice(0, 400));
  assert.ok(acroBody.includes('Contact Email | PDFTextField | p1 | caption: \\"Telephone\\"'));
  assert.ok(acroBody.includes("captions are printed below their boxes"));
});
await check("MUST-EXCLUDE (rule 2): the payload carries none of the job's values — not the prefilled phone, name or email, not the account", () => {
  for (const v of [HOMEOWNER_PHONE, HOMEOWNER, HOMEOWNER_EMAIL, ACCOUNT, "R0220110013"]) assert.ok(!acroBody.includes(v), `payload carries ${v}`);
});
await check("an MA form is offered the state-scoped licence, never the Oregon CCB; an OR form still gets the CCB", () => {
  assert.ok(!acroBody.includes("client.ccbLicenseNumber  (OREGON"), "CCB offered on an MA form");
  assert.ok(acroBody.includes("client.stateContractorLicense"));
  assert.ok(fieldSourcesForState("OR").some((s) => s.startsWith("client.ccbLicenseNumber")));
  assert.ok(!fieldSourcesForState("MA").some((s) => s.startsWith("client.ccbLicenseNumber")));
  assert.ok(fieldSourcesForState("MA").some((s) => s.startsWith("computed.estimatedJobValue")) && fieldSourcesForState("MA").some((s) => s.startsWith("snapshot.parcelNumber")));
});
await check("post-map: the cost table keeps ONLY the Total row", () => {
  assert.ok(built);
  const bound = COST_ROWS.map((_, i) => built!.textFields[costName(i)]);
  assert.deepEqual(bound, [undefined, undefined, undefined, undefined, undefined, "computed.estimatedJobValue"]);
});
await check("post-map: a licence holder's slot never binds the applicant signer; the CCB on an MA form is rebound to the MA licence", () => {
  assert.equal(built!.textFields["Licensed Construction Supervisor"], undefined);
  assert.equal(built!.textFields["License Number"], "client.stateContractorLicense");
});
await check("post-map: declarant and printed name under one signature bound to different people are both dropped and named", () => {
  assert.equal(built!.textFields.NAME, undefined);
  assert.equal(built!.textFields["Print Name"], undefined);
  assert.equal(built!.textFields["hereby authorize"], "project.homeownerName", "7a's owner declarant is another signature block — untouched");
  assert.ok(built!.operatorItems.some((i) => /NAME|I,/.test(i.label) && /Print Name/.test(i.label)), JSON.stringify(built!.operatorItems));
});
await check("post-map: the workers'-comp \"Yes\" box and a constant \"Not Applicable\" are never ticked; operator: blanks become named items", () => {
  assert.deepEqual(built!.checkboxes, {});
  assert.ok(built!.operatorItems.some((i) => /Workers' Compensation/i.test(i.label)));
  assert.ok(built!.operatorItems.some((i) => i.label === "Registration Number" && i.field === "Registration Number"));
});

// =============================================================================================
console.log("\nB2-B5, B7. THE FILL — a stored UNVERIFIED map with Waltham's defects, on an MA job");
const STALE_MAP = {
  formName: "Residential Application", sourceUrl: "", fillMode: "acroform" as const, preserveInteractive: true,
  textFields: {
    "Name Print": "project.homeownerName",
    Telephone: "snapshot.homeownerPhone",                 // the live defect: a phone in the email box
    "Contact Email": "client.installerEmail",             // an email in a phone box
    "License Number": "client.ccbLicenseNumber",          // Oregon's CCB in an MA slot
    "Licensed Construction Supervisor": "computed.applicantSignerName",
    NAME: "computed.applicantSignerName",
    "Print Name": "project.homeownerName",
    "hereby authorize": "project.homeownerName",
    "my behalf in all matters": "client.installerCompanyName",
  },
  checkboxes: { Yes: { source: "lit:X" } },
  notes: "",
};
const storeStale = (ahj: string, map: Record<string, unknown>) => storeAhjFormTemplate(db, {
  ahjName: ahj, state: "MA", formType: "permit_application", filename: "Residential Application.pdf", bytes: BLANK, map: map as never,
});
storeStale("City of Shiftville", STALE_MAP);
const staleTemplate = loadStoredTemplates(db, "City of Shiftville", "MA")[0];
const staleOut = outPath("stale");
const staleRes = await fillLoadedForm(staleTemplate.def, staleTemplate.bytes, ctxFor(maJob), staleOut);
const staleForm = await readFields(staleOut);
const items = staleRes.operatorItems ?? [];
await check("B2 MUST-PASS the guard: the phone mapped into the box captioned Email Address is left BLANK and named", () => {
  assert.equal(textOf(staleForm, "Telephone"), "");
  assert.ok(items.some((i) => /^Email Address \(left blank: an email box/.test(i)), items.join(" | "));
});
await check("B2 MUST-PASS: an email address mapped into the box captioned Telephone is left blank and named", () => {
  assert.equal(textOf(staleForm, "Contact Email"), "");
  assert.ok(items.some((i) => /^Telephone \(left blank: a phone box/.test(i)), items.join(" | "));
});
await check("B3 MUST-EXCLUDE: an MA job's licence slot never gets the Oregon CCB — blank, and named for the operator", () => {
  assert.equal(textOf(staleForm, "License Number"), "");
  assert.ok(items.some((i) => /^License Number \(an Oregon CCB number is not a MA licence/.test(i)), items.join(" | "));
});
await check("B3: the licence holder's slot on an unverified map is not the applicant signer", () => {
  assert.equal(textOf(staleForm, "Licensed Construction Supervisor"), "");
});
await check("B4: the 7b declarant and printed name bound to different people are BOTH left blank and named; 7a is filled", () => {
  assert.equal(textOf(staleForm, "NAME"), "");
  assert.equal(textOf(staleForm, "Print Name"), "");
  assert.equal(textOf(staleForm, "hereby authorize"), HOMEOWNER);
  assert.equal(textOf(staleForm, "my behalf in all matters"), "Shift Solar LLC");
  assert.ok(items.some((i) => i.startsWith("I, ___, as Owner/Authorized Agent / Print Name (one signature, bound to different people")), items.join(" | "));
});
await check("B5: the valuation fills ONLY the Total row (the operator formula: 40% of 19565 = 7826); rows 1-5 stay blank", () => {
  assert.deepEqual(COST_ROWS.map((_, i) => textOf(staleForm, costName(i))), ["", "", "", "", "", "7826"]);
});
await check("B7: the workers'-comp affidavit box is never ticked, and is named", () => {
  assert.equal(staleForm.getCheckBox("Yes").isChecked(), false);
  assert.ok(items.some((i) => /Workers' Compensation Affidavit Attached \(an attestation/.test(i)), items.join(" | "));
});
await check("the owner's name still fills (the checks refuse only what they should)", () => {
  assert.equal(textOf(staleForm, "Name Print"), HOMEOWNER);
});

console.log("\n   MUST-PASS counterparts — the right value goes in");
{
  storeStale("City of Rightville", {
    ...STALE_MAP,
    textFields: {
      Telephone: "client.installerEmail", "Contact Email": "snapshot.homeownerPhone", "License Number": "client.stateContractorLicense",
      NAME: "computed.applicantSignerName", "Print Name": "computed.applicantSignerName",
    },
  });
  const tmpl = loadStoredTemplates(db, "City of Rightville", "MA")[0];
  const run = async (project: typeof maJob, phone: string, tag: string) => {
    const ctx = ctxFor(project);
    ctx.snapshot = { ...ctx.snapshot, homeownerPhone: phone };
    const out = outPath(`right-${tag}`);
    const res = await fillLoadedForm(tmpl.def, tmpl.bytes, ctx, out);
    return { form: await readFields(out), res };
  };
  const ext = await run(maLicensedJob, "(541) 555-0123 ext. 4", "ext");
  await check("B2 MUST-PASS: a real email fills the box captioned Email Address", () => assert.equal(textOf(ext.form, "Telephone"), "ops@baystate.test"));
  await check("B2 MUST-PASS: a phone with an extension fills the box captioned Telephone (no 10-digit demand)", () => assert.equal(textOf(ext.form, "Contact Email"), "(541) 555-0123 ext. 4"));
  const foreign = await run(maLicensedJob, "+44 20 7946 0958", "foreign");
  await check("B2 MUST-PASS: a foreign phone number fills it too", () => assert.equal(textOf(foreign.form, "Contact Email"), "+44 20 7946 0958"));
  await check("B3 MUST-PASS: the MA licence on file fills the MA licence slot", () => assert.equal(textOf(ext.form, "License Number"), "CS-123456"));
  await check("B4 MUST-PASS: declarant and printed name bound to the one signer source both fill with the same person", () => {
    assert.equal(textOf(ext.form, "NAME"), SIGNER);
    assert.equal(textOf(ext.form, "Print Name"), SIGNER);
  });
  const none = await run(maJob, HOMEOWNER_PHONE, "nolicence");
  await check("B3/B7: with no MA licence on file the slot is blank and the operator is told which licence is missing", () => {
    assert.equal(textOf(none.form, "License Number"), "");
    assert.ok((none.res.operatorItems ?? []).some((i) => /^License Number \(no MA contractor licence on file/.test(i)), (none.res.operatorItems ?? []).join(" | "));
  });
}
await check("B3 MUST-PASS: an OREGON job's map bound to the CCB still gets the CCB", () => {
  const orCtx = ctxFor(orJob);
  assert.equal(resolveSource("client.ccbLicenseNumber", orCtx), "223690");
  assert.equal(resolveSource("client.stateContractorLicense", orCtx), "223690");
  const maCtx = ctxFor(maJob);
  assert.equal(resolveSource("client.ccbLicenseNumber", maCtx), "");
  assert.equal(resolveSource("client.stateContractorLicense", maCtx), "");
  assert.equal(resolveSource("computed.installerBlock", maCtx), "Shift Solar LLC", "no 'CCB 223690' tail on an MA job");
});

// =============================================================================================
console.log("\nB6 + B7. ACQUISITION — the vision pass's placements where no widget is; named operator items");
visionReply = JSON.stringify({
  fields: [
    // ON the "Telephone" widget (x=325, y=600): the AcroForm fill covers it — dropped.
    { source: "client.installerEmail", page: 0, nx: 325 / 612, ny: 1 - 600 / 792, size: 9, maxWidthFrac: null, label: "Email Address" },
    // ON the "Company Name" widget, which the AcroForm map leaves UNMAPPED (x=45, y=444): a widget is
    // there, so the value belongs in the widget or nowhere — dropped (only the widget test can drop it;
    // the kill K6a showed the placement above is also caught by the same-source-beside-its-widget rule).
    { source: "client.installerCompanyName", page: 0, nx: 45 / 612, ny: 1 - 444 / 792, size: 9, maxWidthFrac: null, label: "Company Name" },
    // At the widget-less "Map Number" blank (x=325, y=313): kept as an overlay.
    { source: "snapshot.parcelNumber", page: 1, nx: 325 / 612, ny: 1 - 313 / 792, size: 9, maxWidthFrac: null, label: "Map Number" },
    // A printed blank no source answers.
    { source: "operator:Zoning District", page: 1, nx: 45 / 612, ny: 1 - 313 / 792, size: 9, maxWidthFrac: null, label: "Zoning District" },
    // A mark attesting the affidavit is attached, off any widget: never drawn.
    { source: "lit:X", page: 1, nx: 250 / 612, ny: 1 - 740 / 792, size: 9, maxWidthFrac: null, label: "Signed Workers' Compensation Affidavit Attached Yes" },
  ],
  signatures: [{ role: "applicant", page: 1, nx: 45 / 612, ny: 1 - 370 / 792, widthFrac: 0.3, heightFrac: 0.02, dateNx: null, dateNy: null, label: "Signature of Owner/Agent" }],
  notes: "stub vision",
});
acroReply = JSON.stringify({
  textFields: [
    { name: "Name Print", source: "project.homeownerName" },
    { name: "Telephone", source: "client.installerEmail" },
    { name: costName(5), source: "computed.estimatedJobValue" },
    { name: "NAME", source: "computed.applicantSignerName" },
    { name: "Print Name", source: "computed.applicantSignerName" },
    { name: "Licensed Construction Supervisor", source: "operator:Licensed Construction Supervisor" },
  ],
  checkboxes: [], notes: "stub mapper",
});
captured.length = 0;
const acquired = await acquireFromBytes(db, provider, { ahj: "City of Shiftville", state: "MA", formType: "permit_application", formName: "Residential Application", bytes: BLANK, sourceUrl: "" });
const storedMap = JSON.parse(db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE lower(ahj_name) = lower(?) AND form_type = 'permit_application'", ["City of Shiftville"])!.field_map);
await check("B6: the vision pass streams with a multi-page ceiling (not the 4096 that truncated Waltham)", () => {
  const body = visionCalls()[0]?.body ?? {};
  assert.equal(body.stream, true);
  assert.ok(Number(body.max_tokens) >= 16000 && Number(body.max_tokens) === FLAT_FORM_OVERLAY_MAX_TOKENS, String(body.max_tokens));
});
await check("B6: only the placement where NO widget is was kept (those on the \"Telephone\" and unmapped \"Company Name\" widgets were dropped)", () => {
  assert.equal(acquired.status, "acquired", acquired.message);
  assert.equal(storedMap.fillMode, "acroform");
  assert.deepEqual((storedMap.overlayFields ?? []).map((o: { source: string }) => o.source), ["snapshot.parcelNumber"]);
  assert.equal((storedMap.signatureFields ?? []).length, 1, "the vision pass's signature line is stored");
});
await check("B7: the stored map names what no source answers (Zoning District, the licence holder, the WC attestation)", () => {
  const labels = (storedMap.operatorItems ?? []).map((i: { label: string }) => i.label).join(" | ");
  assert.ok(/Zoning District/.test(labels) && /Licensed Construction Supervisor/.test(labels) && /Workers' Compensation/.test(labels), labels);
});
const pkg = await buildFilledFormsForProject(db, getProjectDetail(db, maJob.id).project);
const filled = pkg.forms.find((f) => f.templateId && f.status === "filled");
await check("B7: the fill result lists the unfilled labels for the operator", () => {
  assert.ok(filled, JSON.stringify(pkg.forms.map((f) => [f.formName, f.status, f.message])));
  const labels = (filled!.operatorItems ?? []).join(" | ");
  for (const want of ["Zoning District", "Licensed Construction Supervisor", "Workers' Compensation"]) assert.ok(labels.includes(want), `${want} missing from: ${labels}`);
});
await check("B6: the widget-less Map Number blank is drawn with the parcel number; the email box has the agent email; Total has the valuation", async () => {
  const labels = await extractLabels(new Uint8Array(fs.readFileSync(filled!.outputPath!)));
  const parcel = labels.find((l) => l.str.includes("R0220110013"));
  assert.ok(parcel && parcel.page === 1 && Math.abs(parcel.y - 312) <= 4, JSON.stringify(parcel));
  const email = labels.find((l) => l.str.includes("ops@shiftsolar.test"));
  assert.ok(email && email.page === 0 && email.y > 594 && email.y < 608, JSON.stringify(email));
  const value = labels.filter((l) => l.str.trim() === "7826");
  assert.equal(value.length, 1, JSON.stringify(value));
  assert.ok(value[0].page === 1 && value[0].y > 620 && value[0].y < 636, JSON.stringify(value[0]));
});

// =============================================================================================
console.log("\nB8. RE-MAP — an unverified stored map re-maps from its blob; a verified one is never touched");
{
  // The live shape: a stale unverified map (the Waltham row). Re-mapped through the new pipeline.
  const id = storeAhjFormTemplate(db, { ahjName: "Town of Remap", state: "MA", formType: "permit_application", filename: "Residential Application.pdf", bytes: BLANK, map: STALE_MAP as never, retrievedAt: "2026-09-01T00:00:00.000Z" });
  captured.length = 0;
  const res = await remapStoredTemplate(db, provider, id);
  const row = db.get<{ field_map: string; retrieved_at: string }>("SELECT field_map, retrieved_at FROM ahj_form_templates WHERE id = ?", [id])!;
  const map = JSON.parse(row.field_map);
  await check("an UNVERIFIED map is re-mapped from its stored blob (captions on the wire, new map stored, still unverified, retrieved_at kept)", () => {
    assert.equal(res.status, "acquired", res.message);
    assert.ok(acroCalls().length >= 1 && JSON.stringify(acroCalls()[0].body).includes('caption: \\"Email Address\\"'));
    assert.equal(map.textFields.Telephone, "client.installerEmail");
    assert.equal(map.verified, false);
    assert.equal(row.retrieved_at, "2026-09-01T00:00:00.000Z");
  });
  // A person verifies it (the same write PATCH /api/ahj-templates/:id/verify makes).
  const verifiedMap = { ...map, verified: true, verifiedAt: "2026-09-28T12:00:00.000Z" };
  db.run("UPDATE ahj_form_templates SET field_map = ? WHERE id = ?", [JSON.stringify(verifiedMap), id]);
  const before = db.get<{ field_map: string; updated_at: string }>("SELECT field_map, updated_at FROM ahj_form_templates WHERE id = ?", [id])!;
  captured.length = 0;
  const again = await remapStoredTemplate(db, provider, id);
  const after = db.get<{ field_map: string; updated_at: string }>("SELECT field_map, updated_at FROM ahj_form_templates WHERE id = ?", [id])!;
  await check("MUST-EXCLUDE (rule 3): a VERIFIED map is never re-mapped — no model call, row untouched, and it says why", () => {
    assert.equal(again.status, "exists");
    assert.match(again.message, /HUMAN-VERIFIED/);
    assert.equal(captured.length, 0, `${captured.length} model call(s)`);
    assert.equal(after.field_map, before.field_map);
    assert.equal(after.updated_at, before.updated_at);
  });
  await check("the Re-map button's route goes through remapStoredTemplate (the one door)", () => {
    const src = fs.readFileSync(path.join(REPO, "backend", "src", "server.ts"), "utf8");
    const route = src.slice(src.indexOf('"/api/ahj-templates/:id/remap"'), src.indexOf('"/api/ahj-templates/:id/remap"') + 900);
    assert.match(route, /remapStoredTemplate\(db,/);
    assert.doesNotMatch(route, /acquireFromBytes/);
  });
}

server.close();
db.close();
console.log(failures ? `\nformsFillRight: ${failures} FAILED, ${passed} passed` : `\nformsFillRight: all ${passed} checks passed — captions reach the mapper (no project value does), the shape guard, licence by state, one signer one name, the Total row only, vision placements where no widget is, named operator items, and a verified map is never re-mapped`);
process.exit(failures ? 1 : 0);
