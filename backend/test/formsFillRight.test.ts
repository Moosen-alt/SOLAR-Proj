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
const { acquireFromBytes, buildFieldMapForPdf, fieldSourcesForState, remapStoredTemplate, storeAhjFormTemplate, VerifiedTemplateRefusal } = await import("../src/ahjFormAuto");
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

// =============================================================================================
// SKEPTIC ROUND (forms-fill-2). Each block below was killed: the fix disabled, the block RED, the
// fix restored (the commit message records every kill).
// =============================================================================================
const {
  signerNameConflicts, sanitizeAcroMap, widgetLabel, operatorItemLabels, workersCompAffidavitItem, namesWorkersComp, isSignatureLine, NOT_APPLICABLE_ITEM,
} = await import("../src/formFieldChecks");
const { storedTemplateIsVerified } = await import("../src/jurisdictionHarvest");
type Painter = { page: PDFPage; t: (s: string, x: number, y: number) => void; box: (name: string, x: number, y: number, w: number, h?: number, maxLength?: number) => void; tick: (name: string, x: number, y: number) => void; line: (x: number, y: number, w: number) => void };
/** A generated one-page blank: printed text, text boxes (optionally with a maxLength), check boxes. */
async function blankOf(paint: (p: Painter) => void, opts: { widgets?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  paint({
    page,
    t: (s, x, y) => page.drawText(s, { x, y, size: 9, font }),
    box: (name, x, y, w, h = 12, maxLength) => {
      if (opts.widgets === false) { page.drawRectangle({ x, y, width: w, height: h, borderWidth: 0.5 }); return; }
      const f = form.createTextField(name);
      if (maxLength) f.setMaxLength(maxLength);
      f.addToPage(page, { x, y, width: w, height: h });
    },
    tick: (name, x, y) => form.createCheckBox(name).addToPage(page, { x, y, width: 9, height: 9 }),
    line: (x, y, w) => page.drawRectangle({ x, y, width: w, height: 13, borderWidth: 0.5 }),
  });
  return doc.save();
}
const conflictsOf = async (bytes: Uint8Array, textFields: Record<string, string>) => {
  const got = await inspectPlacedFields(bytes);
  return signerNameConflicts(got.fields, textFields, got.labels);
};
const LONG_OWNER_SIG = "Signature of Property Owner or Authorized Agent (as required by Section 105.1 of the Building Code)";
const LONG_APPLICANT_SIG = "Signature of Applicant / Contractor (the licensee named in Section 3 of this application)";

console.log("\nB-2. ONE SIGNER, ONE NAME — only ONE declarant with ONE Print Name, stacked, with no signature line between");
{
  // L1 — side-by-side Owner / Contractor "Print Name" blocks (captions under the boxes).
  const L1 = await blankOf(({ t, box }) => {
    t("OWNER", 42, 530); t("CONTRACTOR", 322, 530);
    box("Owner Print Name", 40, 500, 240); t("Print Name", 42, 490);
    box("Contractor Print Name", 320, 500, 240); t("Print Name", 322, 490);
    t("Owner Signature", 42, 460); t("Contractor Signature", 322, 460);
  });
  await check("MUST-PASS: side-by-side Owner / Contractor Print Name blocks bound to two people are two signers — no conflict", async () => {
    assert.deepEqual(await conflictsOf(L1, { "Owner Print Name": "project.homeownerName", "Contractor Print Name": "computed.applicantSignerName" }), []);
  });
  // L2 — stacked "Owner Printed Name:" / "Contractor Printed Name:" rows (caption left of the box,
  // each row's signature caption to its right — nothing printed BETWEEN the two rows).
  const L2 = await blankOf(({ t, box }) => {
    t("Owner Printed Name:", 40, 603); box("Owner Printed Name", 150, 600, 200); t("Owner Signature:", 370, 603);
    t("Contractor Printed Name:", 40, 573); box("Contractor Printed Name", 150, 570, 200); t("Contractor Signature:", 370, 573);
  });
  await check("MUST-PASS (kills the declarant x Print Name rule): stacked Owner Printed Name / Contractor Printed Name rows are two signers", async () => {
    assert.deepEqual(await conflictsOf(L2, { "Owner Printed Name": "project.homeownerName", "Contractor Printed Name": "computed.applicantSignerName" }), []);
  });
  // L3 — an owner's "I, ___ authorize" and an applicant's "I, ___ certify", each under a LONG
  // signature caption (> 60 characters).
  const L3 = await blankOf(({ t, box }) => {
    t("I,", 40, 700); box("Owner Name", 50, 696, 250, 13); t(", as owner, authorize the contractor to act for me.", 310, 697);
    t(LONG_OWNER_SIG, 40, 670);
    t("I,", 40, 640); box("Applicant Name", 50, 636, 250, 13); t(", certify that this application is true.", 310, 637);
    t(LONG_APPLICANT_SIG, 40, 610);
  });
  await check("MUST-PASS: an owner's \"I, ___ authorize\" and an applicant's \"I, ___ certify\" under long signature captions are two signers", async () => {
    assert.deepEqual(await conflictsOf(L3, { "Owner Name": "project.homeownerName", "Applicant Name": "computed.applicantSignerName" }), []);
  });
  // L4 — a declarant and a Print Name SIDE BY SIDE at one height (no horizontal overlap).
  const L4 = await blankOf(({ t, box }) => {
    t("I,", 40, 500); box("Owner Declarant", 50, 496, 220, 13);
    box("Contractor Print Name", 320, 496, 240); t("Print Name", 322, 486);
    t("Owner Signature", 42, 460); t("Contractor Signature", 322, 460);
  });
  await check("MUST-PASS (kills the same-row rule): a declarant and a Print Name side by side at one height never pair", async () => {
    assert.deepEqual(await conflictsOf(L4, { "Owner Declarant": "project.homeownerName", "Contractor Print Name": "computed.applicantSignerName" }), []);
  });
  // L5 — a declarant and a Print Name stacked, overlapping, 56pt apart, separated ONLY by a long
  // signature caption.
  const L5 = await blankOf(({ t, box }) => {
    t("I,", 40, 700); box("Owner Name", 50, 696, 300, 13); t(", as owner, authorize the contractor.", 360, 697);
    t(LONG_OWNER_SIG, 40, 670);
    box("Print Name", 40, 640, 300, 13); t("Print Name", 42, 630);
    t("Signature of Applicant", 40, 600);
  });
  await check("MUST-PASS (kills the length cap): a signature line longer than 60 characters between them separates two blocks", async () => {
    assert.deepEqual(await conflictsOf(L5, { "Owner Name": "project.homeownerName", "Print Name": "computed.applicantSignerName" }), []);
  });
  // MUST-EXCLUDE — Waltham 7b: the declarant and the Print Name under the SAME signature (the long
  // signature caption is BELOW both), bound to two different sources.
  const W7b = await blankOf(({ t, box }) => {
    t("I,", 40, 700); box("NAME", 50, 696, 300, 13); t(", as Owner/Authorized Agent", 360, 697);
    t("Hereby declare that the statements and information are true.", 40, 680);
    box("Print Name", 40, 650, 400, 13); t("Print Name", 42, 638);
    t(LONG_OWNER_SIG, 40, 610);
  });
  await check("MUST-EXCLUDE: a declarant and the Print Name under the SAME signature bound to two sources is still flagged (Waltham 7b)", async () => {
    const got = await conflictsOf(W7b, { NAME: "computed.applicantSignerName", "Print Name": "project.homeownerName" });
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.deepEqual(got[0].fields, ["NAME", "Print Name"]);
    assert.deepEqual(got[0].sources, ["computed.applicantSignerName", "project.homeownerName"]);
  });
  await check("MUST-EXCLUDE: bound to ONE source, the same 7b pair is no conflict", async () => {
    assert.deepEqual(await conflictsOf(W7b, { NAME: "computed.applicantSignerName", "Print Name": "computed.applicantSignerName" }), []);
  });
  // forms-fill-3 (skeptic P1) — the declaration starts "I, ___" at the LEFT; the Print Name box sits
  // in the RIGHT column of the signature row below it ("Signature ____ | Print Name ____"). One signer;
  // their horizontal ranges do not overlap, which the previous round took for two blocks.
  const P1 = await blankOf(({ t, box }) => {
    t("OWNER / AUTHORIZED AGENT DECLARATION", 40, 640);
    t("I,", 40, 600); box("Declarant", 50, 596, 200, 13); t(", as Owner/Authorized Agent, hereby declare that the statements", 255, 597);
    t("and information on the foregoing application are true and accurate.", 40, 585);
    box("Print Name", 330, 555, 230, 13);
    t("Signature", 42, 545); t("Print Name", 332, 545);
  });
  await check("MUST-EXCLUDE (skeptic P1): a left \"I, ___\" and a right-column Print Name on the signature row below, bound to two people, are FLAGGED", async () => {
    const got = await conflictsOf(P1, { Declarant: "computed.applicantSignerName", "Print Name": "project.homeownerName" });
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.deepEqual(got[0].fields, ["Declarant", "Print Name"]);
  });
  // forms-fill-3 (skeptic P2) — the Waltham 7b pair with declaration prose that MENTIONS a signature
  // between them. Prose is not a signature line: only a line that STARTS with "Signature" is.
  const P2 = await blankOf(({ t, box }) => {
    t("I,", 40, 700); box("NAME", 50, 696, 300, 13); t(", as Owner/Authorized Agent", 360, 697);
    t("hereby declare that the statements are true; I understand my signature below is made under oath.", 40, 680);
    box("Print Name", 40, 650, 400, 13); t("Print Name", 42, 638);
    t("Signature of Owner/Agent", 40, 610);
  });
  await check("MUST-EXCLUDE (skeptic P2): prose that mentions \"signature\" between the declarant and the Print Name does not separate them — FLAGGED", async () => {
    const got = await conflictsOf(P2, { NAME: "computed.applicantSignerName", "Print Name": "project.homeownerName" });
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.deepEqual(got[0].fields, ["NAME", "Print Name"]);
  });
  await check("a signature LINE starts with \"Signature\", optionally after at most three signer words; prose that mentions one is not a line", () => {
    for (const s of ["Signature", "Signature of Owner/Agent", LONG_OWNER_SIG, "Owner's Signature", "Contractor / Agent Signature:", "Owner or Authorized Agent Signature"]) assert.ok(isSignatureLine(s), s);
    // A four-word prefix is past the cap: not read as a separator (the pair is flagged — the safe side).
    for (const s of ["I understand my signature below is made under oath.", "my signature below is made under oath", "hereby declare; signature required", "Date of Signature", "The owner and contractor must provide a signature", "Property Owner or Authorized Agent Signature"]) assert.ok(!isSignatureLine(s), s);
  });
  // One declarant over a row with the OWNER's and the CONTRACTOR's Print Names side by side, each
  // bound to its own person: the declarant pairs with the Print Name under it (nearest, then the one
  // straight below), which is the same person — no conflict.
  const OVER2 = await blankOf(({ t, box }) => {
    t("I,", 40, 600); box("Owner Declarant", 50, 596, 230, 13); t(", as owner, authorize the contractor below.", 290, 597);
    box("Owner Print Name", 40, 555, 240); t("Print Name", 42, 545);
    box("Contractor Print Name", 320, 555, 240); t("Print Name", 322, 545);
    t("Owner Signature", 42, 515); t("Contractor Signature", 322, 515);
  });
  await check("MUST-PASS: a declarant over side-by-side Owner / Contractor Print Names, each bound to its own person, is not flagged", async () => {
    assert.deepEqual(await conflictsOf(OVER2, { "Owner Declarant": "project.homeownerName", "Owner Print Name": "project.homeownerName", "Contractor Print Name": "computed.applicantSignerName" }), []);
  });
  // P1 at the FILL door: an unverified stored map writes neither name, and names the pair.
  storeAhjFormTemplate(db, { ahjName: "Town of Right Column", state: "MA", formType: "permit_application", filename: "Right Column.pdf", bytes: P1,
    map: { formName: "Right Column", sourceUrl: "", fillMode: "acroform", preserveInteractive: true, textFields: { Declarant: "computed.applicantSignerName", "Print Name": "project.homeownerName" }, checkboxes: {}, notes: "" } as never });
  const rc = loadStoredTemplates(db, "Town of Right Column", "MA")[0];
  const rcOut = outPath("right-column");
  const rcRes = await fillLoadedForm(rc.def, rc.bytes, ctxFor(maJob), rcOut);
  await check("MUST-EXCLUDE at the fill door (skeptic P1): neither the org's signer nor the homeowner is written; the pair is named for the operator", async () => {
    const f = await readFields(rcOut);
    assert.equal(textOf(f, "Declarant"), "");
    assert.equal(textOf(f, "Print Name"), "");
    assert.ok((rcRes.operatorItems ?? []).some((i) => /^I, ___.* \/ Print Name \(one signature, bound to different people/.test(i)), (rcRes.operatorItems ?? []).join(" | "));
  });
  // The fill door: the L1 blank as an UNVERIFIED stored map — both printed names are written.
  storeAhjFormTemplate(db, { ahjName: "Town of Two Signers", state: "MA", formType: "permit_application", filename: "Two Signers.pdf", bytes: L1,
    map: { formName: "Two Signers", sourceUrl: "", fillMode: "acroform", preserveInteractive: true, textFields: { "Owner Print Name": "project.homeownerName", "Contractor Print Name": "computed.applicantSignerName" }, checkboxes: {}, notes: "" } as never });
  const two = loadStoredTemplates(db, "Town of Two Signers", "MA")[0];
  const twoOut = outPath("two-signers");
  const twoRes = await fillLoadedForm(two.def, two.bytes, ctxFor(maJob), twoOut);
  await check("MUST-PASS at the fill door: side-by-side owner and contractor Print Names both fill on an unverified map", async () => {
    const f = await readFields(twoOut);
    assert.equal(textOf(f, "Owner Print Name"), HOMEOWNER);
    assert.equal(textOf(f, "Contractor Print Name"), SIGNER);
    assert.ok(!(twoRes.operatorItems ?? []).some((i) => /one signature/.test(i)), (twoRes.operatorItems ?? []).join(" | "));
  });
}

console.log("\nB-3. ONE BOX NEVER FAILS THE FORM — the valuation default is guarded per field");
{
  const small = await blankOf(({ t, box }) => {
    box("Owner Name", 40, 700, 250); t("Owner Name", 42, 690);
    box("Estimated Job Value", 320, 700, 40, 12, 3); t("Estimated Job Value", 322, 690);
  });
  storeAhjFormTemplate(db, { ahjName: "Town of Small Box", state: "MA", formType: "permit_application", filename: "Small Box.pdf", bytes: small,
    map: { formName: "Small Box", sourceUrl: "", fillMode: "acroform", preserveInteractive: true, textFields: { "Owner Name": "project.homeownerName" }, checkboxes: {}, notes: "" } as never });
  const tmpl = loadStoredTemplates(db, "Town of Small Box", "MA")[0];
  const out = outPath("small-box");
  let res: Awaited<ReturnType<typeof fillLoadedForm>> | null = null;
  let thrown = "";
  try { res = await fillLoadedForm(tmpl.def, tmpl.bytes, ctxFor(maJob), out); } catch (err) { thrown = err instanceof Error ? err.message : String(err); }
  await check("a valuation box with maxLength=3 does not fail the form: status filled, the owner's name written", async () => {
    assert.equal(thrown, "", `fillLoadedForm threw: ${thrown}`);
    assert.equal(res?.status, "filled");
    assert.equal(textOf(await readFields(out), "Owner Name"), HOMEOWNER);
  });
  await check("the too-small valuation box is left blank and named for the operator", async () => {
    assert.equal(textOf(await readFields(out), "Estimated Job Value"), "");
    assert.ok((res?.operatorItems ?? []).some((i) => /^Estimated Job Value \(left blank: the valuation is longer than this box allows/.test(i)), (res?.operatorItems ?? []).join(" | "));
  });
}

console.log("\n(a) RULE 3. AN ACQUISITION NEVER OVERWRITES A HUMAN-VERIFIED MAP");
{
  const verify = (id: string) => {
    const row = db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE id = ?", [id])!;
    db.run("UPDATE ahj_form_templates SET field_map = ? WHERE id = ?", [JSON.stringify({ ...JSON.parse(row.field_map), verified: true, verifiedAt: "2026-09-28T12:00:00.000Z" }), id]);
  };
  const keepId = storeAhjFormTemplate(db, { ahjName: "Town of Keepsake", state: "MA", formType: "permit_application", filename: "Residential Application.pdf", bytes: BLANK,
    map: { ...STALE_MAP, textFields: { "Name Print": "project.homeownerName" } } as never });
  verify(keepId);
  const before = db.get<{ field_map: string; updated_at: string; pdf_blob: Buffer }>("SELECT field_map, updated_at, pdf_blob FROM ahj_form_templates WHERE id = ?", [keepId])!;
  const otherBlank = await blankOf(({ t, box }) => { box("Applicant", 40, 700, 250); t("Applicant", 42, 690); box("Address", 320, 700, 250); t("Address", 322, 690); });
  acroReply = JSON.stringify({ textFields: [{ name: "Applicant", source: "computed.applicantSignerName" }], checkboxes: [], notes: "stub" });
  visionReply = JSON.stringify({ fields: [], signatures: [], notes: "stub vision" });
  captured.length = 0;
  const upload = await acquireFromBytes(db, provider, { ahj: "Town of Keepsake", state: "MA", formType: "permit_application", formName: "Residential Application", bytes: otherBlank, sourceUrl: "" });
  const after = db.get<{ field_map: string; updated_at: string; pdf_blob: Buffer }>("SELECT field_map, updated_at, pdf_blob FROM ahj_form_templates WHERE id = ?", [keepId])!;
  await check("MUST-EXCLUDE: an upload into a slot a person VERIFIED is refused — no model call, map, blob and updated_at untouched, and it says why", () => {
    assert.equal(upload.status, "exists", upload.message);
    assert.match(upload.message, /HUMAN-VERIFIED/);
    assert.equal(captured.length, 0, `${captured.length} model call(s)`);
    assert.equal(after.field_map, before.field_map);
    assert.equal(after.updated_at, before.updated_at);
    assert.ok(Buffer.compare(Buffer.from(after.pdf_blob), Buffer.from(before.pdf_blob)) === 0, "blob replaced");
    assert.equal(db.query("SELECT id FROM ahj_form_templates WHERE lower(ahj_name) = lower(?)", ["Town of Keepsake"]).length, 1);
  });
  // MUST-PASS: an UNVERIFIED row in the same slot is replaced as before.
  const freeId = storeAhjFormTemplate(db, { ahjName: "Town of Replace", state: "MA", formType: "permit_application", filename: "Residential Application.pdf", bytes: BLANK,
    map: { ...STALE_MAP, textFields: { "Name Print": "project.homeownerName" } } as never });
  const replaced = await acquireFromBytes(db, provider, { ahj: "Town of Replace", state: "MA", formType: "permit_application", formName: "Residential Application", bytes: otherBlank, sourceUrl: "" });
  await check("MUST-PASS: an UNVERIFIED map in the same slot is replaced by the new blank's map", () => {
    assert.equal(replaced.status, "acquired", replaced.message);
    const map = JSON.parse(db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE id = ?", [freeId])!.field_map);
    assert.deepEqual(map.textFields, { Applicant: "computed.applicantSignerName" });
  });
  // MUST-PASS: the refusal is the store's own slot — a verified PRESCRIPTIVE building application
  // does not block the STRUCTURAL one (a different slot), and is itself untouched.
  const presId = storeAhjFormTemplate(db, { ahjName: "Town of Two Kinds", state: "MA", formType: "building_application", filename: "Prescriptive Solar Building Application.pdf", bytes: BLANK,
    applicationKind: "prescriptive", map: { ...STALE_MAP, formName: "Prescriptive Solar Building Application", textFields: { "Name Print": "project.homeownerName" } } as never });
  verify(presId);
  const presBefore = db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE id = ?", [presId])!.field_map;
  const structural = await acquireFromBytes(db, provider, { ahj: "Town of Two Kinds", state: "MA", formType: "building_application", formName: "Structural Building Permit Application", bytes: otherBlank, sourceUrl: "", applicationKind: "structural" });
  await check("MUST-PASS: a structural blank is stored beside a verified prescriptive one (another slot); the verified row is untouched", () => {
    assert.equal(structural.status, "acquired", structural.message);
    assert.equal(db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE id = ?", [presId])!.field_map, presBefore);
    assert.equal(db.query("SELECT id FROM ahj_form_templates WHERE lower(ahj_name) = lower(?)", ["Town of Two Kinds"]).length, 2);
  });

  // forms-fill-3: THE ONE CHOKEPOINT. storeAhjFormTemplate itself refuses the row it would ACTUALLY
  // replace, whatever door called it.
  const rowOf = (id: string) => db.get<{ field_map: string; updated_at: string; pdf_blob: Buffer }>("SELECT field_map, updated_at, pdf_blob FROM ahj_form_templates WHERE id = ?", [id])!;
  const storeOrRefusal = (args: Parameters<typeof storeAhjFormTemplate>[1]): { id: string } | { refused: InstanceType<typeof VerifiedTemplateRefusal> } => {
    try { return { id: storeAhjFormTemplate(db, args) }; }
    catch (err) { if (err instanceof VerifiedTemplateRefusal) return { refused: err }; throw err; }
  };
  // Skeptic A1: two building-side rows, the PRESCRIPTIVE one unverified and inserted first, the
  // STRUCTURAL one verified; a kind-less blank arrives from the structural row's own source URL.
  const U = "https://example.test/structural.pdf";
  storeAhjFormTemplate(db, { ahjName: "Town of Harvest", state: "MA", formType: "building_application", filename: "Prescriptive Solar Application.pdf", bytes: BLANK, applicationKind: "prescriptive",
    map: { formName: "Prescriptive Solar Application", sourceUrl: "https://example.test/pres.pdf", fillMode: "overlay", textFields: {}, checkboxes: {}, notes: "" } as never });
  const sid = storeAhjFormTemplate(db, { ahjName: "Town of Harvest", state: "MA", formType: "building_application", filename: "Structural Building Application.pdf", bytes: BLANK, applicationKind: "structural",
    map: { formName: "Structural Building Application", sourceUrl: U, fillMode: "acroform", textFields: { "Name Print": "project.homeownerName" }, checkboxes: {}, notes: "" } as never });
  verify(sid);
  const sBefore = rowOf(sid);
  const harvested = { ahjName: "Town of Harvest", state: "MA", formType: "building_application", filename: "Building Permit Application.pdf", map: { formName: "Building Permit Application", sourceUrl: U } };
  await check("A1: the harvest's predicate (storedTemplateIsVerified) answers about the row the store would replace — the VERIFIED structural one", () => {
    assert.equal(storedTemplateIsVerified(db, harvested), true);
  });
  const a1 = storeOrRefusal({ ...harvested, bytes: otherBlank, map: { ...harvested.map, fillMode: "overlay", textFields: {}, checkboxes: {}, notes: "harvested" } as never });
  await check("MUST-EXCLUDE (skeptic A1): the store itself refuses — \"exists\", HUMAN-VERIFIED — and the verified structural row is untouched", () => {
    assert.ok("refused" in a1, "the store overwrote a human-verified row");
    assert.equal(a1.refused.result.status, "exists");
    assert.match(a1.refused.result.message, /HUMAN-VERIFIED/);
    const after = rowOf(sid);
    assert.equal(after.field_map, sBefore.field_map);
    assert.equal(after.updated_at, sBefore.updated_at);
    assert.ok(Buffer.compare(Buffer.from(after.pdf_blob), Buffer.from(sBefore.pdf_blob)) === 0, "blob replaced");
    assert.equal(db.query("SELECT id FROM ahj_form_templates WHERE lower(ahj_name) = lower(?)", ["Town of Harvest"]).length, 2);
  });
  // A RE-TYPED store: the caller says permit_application, the form's own name says electrical — the
  // row it would replace is the verified ELECTRICAL row.
  const eid = storeAhjFormTemplate(db, { ahjName: "Town of Retype", state: "MA", formType: "electrical_application", filename: "Electrical Permit Application.pdf", bytes: BLANK,
    map: { ...STALE_MAP, formName: "Electrical Permit Application", textFields: { "Name Print": "project.homeownerName" } } as never });
  verify(eid);
  const eBefore = rowOf(eid);
  const retyped = storeOrRefusal({ ahjName: "Town of Retype", state: "MA", formType: "permit_application", filename: "Electrical Permit Application.pdf", bytes: otherBlank,
    map: { formName: "Electrical Permit Application", sourceUrl: "", fillMode: "acroform", textFields: { Applicant: "computed.applicantSignerName" }, checkboxes: {}, notes: "" } as never });
  await check("MUST-EXCLUDE: a store RE-TYPED by the form's own name onto a verified electrical row is refused, the row untouched", () => {
    assert.ok("refused" in retyped, "the re-typed store overwrote a human-verified row");
    assert.match(retyped.refused.result.message, /electrical application slot holds a HUMAN-VERIFIED/);
    assert.equal(rowOf(eid).field_map, eBefore.field_map);
    assert.equal(rowOf(eid).updated_at, eBefore.updated_at);
  });
  captured.length = 0;
  const retypedUpload = await acquireFromBytes(db, provider, { ahj: "Town of Retype", state: "MA", formType: "permit_application", formName: "Electrical Permit Application", bytes: otherBlank, sourceUrl: "" });
  await check("the same re-typed blank as an UPLOAD: \"exists\" before any model call, the verified row untouched", () => {
    assert.equal(retypedUpload.status, "exists", retypedUpload.message);
    assert.equal(captured.length, 0, `${captured.length} model call(s)`);
    assert.equal(rowOf(eid).field_map, eBefore.field_map);
  });
  // The ONE waiver: the 60-day refresh re-storing THAT SAME ROW (the AHJ revised the PDF) demotes it;
  // naming any other row waives nothing.
  const wrongWaiver = storeOrRefusal({ ahjName: "Town of Retype", state: "MA", formType: "electrical_application", filename: "Electrical Permit Application.pdf", bytes: otherBlank, refreshOfRowId: sid,
    map: { formName: "Electrical Permit Application", sourceUrl: "", fillMode: "acroform", textFields: {}, checkboxes: {}, notes: "" } as never });
  await check("MUST-EXCLUDE: a refresh naming a DIFFERENT row is still refused", () => {
    assert.ok("refused" in wrongWaiver);
    assert.equal(rowOf(eid).field_map, eBefore.field_map);
  });
  const ownWaiver = storeOrRefusal({ ahjName: "Town of Retype", state: "MA", formType: "electrical_application", filename: "Electrical Permit Application.pdf", bytes: otherBlank, refreshOfRowId: eid,
    map: { formName: "Electrical Permit Application", sourceUrl: "", fillMode: "acroform", textFields: { "Name Print": "project.homeownerName" }, checkboxes: {}, notes: "refreshed" } as never });
  await check("MUST-PASS: the refresh re-storing its OWN row replaces it, demoted to unverified", () => {
    assert.ok("id" in ownWaiver && ownWaiver.id === eid, JSON.stringify(ownWaiver));
    assert.equal(JSON.parse(rowOf(eid).field_map).verified, false);
  });
}

console.log("\n(b) THE WORKERS' COMPENSATION AFFIDAVIT IS READ OFF THE PAGE — whatever the model returned");
{
  const wcBlank = await blankOf(({ t, box, tick }) => {
    box("Owner Name", 40, 700, 250); t("Owner Name", 42, 690);
    t("Workers' Compensation Insurance", 42, 650); t("Affidavit", 190, 650);   // one line, two text runs
    t("must be completed and submitted with this application.", 42, 638);
    tick("WC Yes", 300, 620); t("Yes", 312, 622);
  });
  storeAhjFormTemplate(db, { ahjName: "Town of Affidavit", state: "MA", formType: "permit_application", filename: "Affidavit Town.pdf", bytes: wcBlank,
    map: { formName: "Affidavit Town", sourceUrl: "", fillMode: "acroform", preserveInteractive: true, textFields: { "Owner Name": "project.homeownerName" }, checkboxes: {}, notes: "" } as never });
  const tmpl = loadStoredTemplates(db, "Town of Affidavit", "MA")[0];
  const out = outPath("affidavit");
  const res = await fillLoadedForm(tmpl.def, tmpl.bytes, ctxFor(maJob), out);
  await check("MUST-PASS: a form printing a workers' compensation affidavit gets the named operator item with NO model item and NO mapped box", () => {
    assert.ok((res.operatorItems ?? []).some((i) => /^Workers' compensation affidavit — the form asks for one \("Workers' Compensation Insurance Affidavit", page 1\)/.test(i)), (res.operatorItems ?? []).join(" | "));
  });
  await check("never ticked: the affidavit's box stays empty", async () => {
    assert.equal((await readFields(out)).getCheckBox("WC Yes").isChecked(), false);
  });
  const flatWc = await blankOf(({ t }) => { t("Owner Name", 42, 690); t("WORKERS' COMPENSATION AFFIDAVIT (attach)", 42, 650); }, { widgets: false });
  storeAhjFormTemplate(db, { ahjName: "Town of Flat Affidavit", state: "MA", formType: "permit_application", filename: "Flat Affidavit.pdf", bytes: flatWc,
    map: { formName: "Flat Affidavit", sourceUrl: "", fillMode: "overlay", textFields: {}, checkboxes: {}, overlayFields: [{ source: "project.homeownerName", page: 0, x: 42, y: 700, size: 9 }], notes: "" } as never });
  const flatTmpl = loadStoredTemplates(db, "Town of Flat Affidavit", "MA")[0];
  const flatRes = await fillLoadedForm(flatTmpl.def, flatTmpl.bytes, ctxFor(maJob), outPath("flat-affidavit"));
  await check("MUST-PASS: a FLAT (overlay) form printing the affidavit gets it too", () => {
    assert.ok((flatRes.operatorItems ?? []).some((i) => /^Workers' compensation affidavit — the form asks for one/.test(i)), (flatRes.operatorItems ?? []).join(" | "));
  });
  await check("MUST-EXCLUDE: an owner's affidavit alone, or a workers' compensation CERTIFICATE, is not the workers' comp affidavit", async () => {
    const other = await blankOf(({ t }) => {
      t("Owner's Affidavit of Ownership", 42, 700);
      t("Workers' Compensation Insurance certificate on file with the city", 42, 650);
    });
    assert.equal(workersCompAffidavitItem(await extractLabels(other)), null);
  });
  await check("MUST-EXCLUDE: a form whose items already name the affidavit gets no second item (the stale Waltham fill: one WC line)", () => {
    assert.equal(items.filter((i) => /workers['’]?\s*comp/i.test(i)).length, 1, items.join(" | "));
  });
  // forms-fill-3: an item for a workers' comp CARRIER box is not the affidavit — it must not hide the
  // page's printed affidavit requirement.
  await check("namesWorkersComp needs the AFFIDAVIT too: a carrier / policy item is not it", () => {
    assert.equal(namesWorkersComp("Workers' Comp Insurance Carrier (no data on file for this job)"), false);
    assert.equal(namesWorkersComp("Signed Workers' Compensation Affidavit Attached (a document attestation — attach it and tick by hand)"), true);
  });
  const carrier = await blankOf(({ t, box }) => {
    box("Owner Name", 40, 720, 250); t("Owner Name", 42, 710);
    box("Workers Comp Insurance Carrier", 40, 680, 250); t("Workers' Comp Insurance Carrier", 42, 670);
    t("A Workers' Compensation Affidavit must be attached to this application.", 42, 640);
  });
  storeAhjFormTemplate(db, { ahjName: "Town of Carrier", state: "MA", formType: "permit_application", filename: "Carrier Application.pdf", bytes: carrier,
    map: { formName: "Carrier Application", sourceUrl: "", fillMode: "acroform", preserveInteractive: true, textFields: { "Owner Name": "project.homeownerName", "Workers Comp Insurance Carrier": "client.workersCompCarrier" }, checkboxes: {}, notes: "" } as never });
  const carrierTmpl = loadStoredTemplates(db, "Town of Carrier", "MA")[0];
  const carrierRes = await fillLoadedForm(carrierTmpl.def, carrierTmpl.bytes, ctxFor(maJob), outPath("carrier"));
  await check("MUST-PASS: a workers' comp CARRIER item does not suppress the page's printed affidavit requirement", () => {
    const got = carrierRes.operatorItems ?? [];
    assert.ok(got.some((i) => /workers['’]?\s*comp/i.test(i) && !/affidavit/i.test(i)), `the fixture must carry a carrier item: ${got.join(" | ")}`);
    assert.ok(got.some((i) => /^Workers' compensation affidavit — the form asks for one/.test(i)), got.join(" | "));
  });
}

console.log("\n(c) \"NOT APPLICABLE\" IS NEVER TICKED AS A CONSTANT — every one removed, every one named");
{
  // forms-fill-3: the base behaviour. Which section a box sits in is not read off the layout (the
  // previous round's 40pt window kept a tick on the heading row and under a heading 70pt up).
  const naBlank = await blankOf(({ t, tick, box }) => {
    t("SECTION 5: CONSTRUCTION SERVICES", 42, 740); t("Not Applicable", 402, 740); tick("NA Heading Row", 470, 738);
    t("5.1 Construction Supervisor License (CSL)", 42, 724);
    t("5.2 Home Improvement Contractor", 42, 700); t("Not Applicable", 402, 700); tick("NA CSL", 470, 698);
    t("SECTION 6 - LICENSED CONTRACTOR", 42, 660);
    box("Company", 40, 635, 250); t("Company Name", 42, 625);
    box("Address", 40, 610, 250); t("Business Address", 42, 600);
    t("Not Applicable (owner-builder)", 42, 590); tick("NA Contractor", 200, 588);
    t("SECTION 8 - HISTORIC DISTRICT", 42, 560);
    t("Historic District review", 42, 540); t("Not Applicable", 402, 540); tick("NA Historic", 470, 538);
    t("Historic district applies", 42, 520); tick("Historic Yes", 200, 518);
  });
  const got = await inspectPlacedFields(naBlank);
  const NA = ["NA Heading Row", "NA CSL", "NA Contractor", "NA Historic"];
  const res = sanitizeAcroMap({ widgets: got.fields, items: got.labels, state: "MA", textFields: {},
    checkboxes: { ...Object.fromEntries(NA.map((n) => [n, { source: "lit:X" }])), "Historic Yes": { source: "lit:X" } } });
  await check("MUST-PASS: EVERY constant Not Applicable tick is removed — the heading row, a licence row, 70pt under a licence heading, a district review", () => {
    for (const n of NA) assert.equal(res.checkboxes[n], undefined, n);
  });
  await check("each removed tick is a named operator item on its own box: \"Not Applicable box left unticked — tick it by hand only if it truly applies\"", () => {
    for (const n of NA) assert.ok(res.operatorItems.some((i) => i.field === n && i.label === NOT_APPLICABLE_ITEM), `${n}: ${JSON.stringify(res.operatorItems)}`);
    assert.equal(NOT_APPLICABLE_ITEM, "Not Applicable box left unticked — tick it by hand only if it truly applies");
    // Four boxes, one label: each told apart by its box.
    assert.equal(operatorItemLabels(res.operatorItems).filter((l) => l.startsWith(NOT_APPLICABLE_ITEM)).length, 4);
  });
  await check("MUST-EXCLUDE: a constant tick on a box that is not Not Applicable stands as mapped", () => {
    assert.deepEqual(res.checkboxes["Historic Yes"], { source: "lit:X" });
    assert.ok(!res.operatorItems.some((i) => i.field === "Historic Yes"));
  });
}

console.log("\n(d) THE MORE MEANINGFUL LABEL, AND ONE LABEL ON TWO BOXES IS TWO ITEMS");
await check("MUST-PASS: a fragment caption (\"#\", \"Approval\", \"Date\") under a descriptive name that contains it takes the name", () => {
  assert.equal(widgetLabel({ name: "License Number", caption: "#" }), "License Number");
  assert.equal(widgetLabel({ name: "Zoning Board Approval", caption: "Approval" }), "Zoning Board Approval");
  assert.equal(widgetLabel({ name: "HIC_Expiration_Date", caption: "Date:" }), "HIC Expiration Date");
});
await check("MUST-EXCLUDE: the caption stands over a shifted name, an auto-generated name, and a run-on name", () => {
  assert.equal(widgetLabel({ name: "Contact Email", caption: "Telephone" }), "Telephone");
  assert.equal(widgetLabel({ name: "Text12", caption: "Date" }), "Date");
  assert.equal(widgetLabel({ name: costName(5), caption: COST_CAPTIONS[5] }), COST_CAPTIONS[5]);
  assert.equal(widgetLabel({ name: "Telephone", caption: "Email Address" }), "Email Address");
});
await check("MUST-PASS: one label on two DIFFERENT boxes is two operator items, each told apart by its box", () => {
  const got = operatorItemLabels([
    { field: "CSL Expiration", label: "Expiration Date (no data on file for this job)" },
    { field: "HIC Expiration", label: "Expiration Date (no data on file for this job)" },
  ]);
  assert.deepEqual(got, [
    'Expiration Date (no data on file for this job) — the box named "CSL Expiration"',
    'Expiration Date (no data on file for this job) — the box named "HIC Expiration"',
  ]);
});
await check("MUST-EXCLUDE: the same item twice (one box, or no box) is listed once", () => {
  assert.deepEqual(operatorItemLabels([{ field: "A", label: "Zoning District" }, { field: "A", label: "Zoning District" }]), ["Zoning District"]);
  assert.deepEqual(operatorItemLabels([{ label: "Zoning District" }, "Zoning District"]), ["Zoning District"]);
});

console.log("\n(e) VISION PLACEMENTS PASS THE SAME MAP CHECKS AS WIDGETS (licence holder, one signer, Total only)");
{
  const hybridBlank = await blankOf(({ t, box, line }) => {
    t("PROPERTY", 42, 770);
    box("Owner Name", 40, 740, 250); t("Owner Name", 42, 730);
    box("Owner Phone", 320, 740, 250); t("Owner Phone", 322, 730);
    line(40, 700, 200); t("Map Number", 42, 690);                                   // printed blank, NO widget
    t("ESTIMATED COSTS", 42, 675);
    t("Estimated Cost: Building", 42, 660); line(190, 657, 150);                    // printed rows, NO widget
    t("Estimated Cost: Electrical", 42, 645); line(190, 642, 150);
    box("Estimated Cost Total", 190, 600, 150); t("Estimated Cost Total", 192, 590);
    t("OWNER AUTHORIZATION", 42, 560);
    t("I,", 42, 540); line(50, 536, 300); t(", as Owner, authorize the contractor to act on my behalf.", 360, 537);  // NO widget
    box("Print Name", 40, 500, 300, 13); t("Print Name", 42, 490);
    t("Signature of Owner", 42, 460);
    t("Licence Holder", 42, 420); line(150, 417, 200);                              // NO widget
  });
  acroReply = JSON.stringify({
    textFields: [
      { name: "Owner Name", source: "project.homeownerName" }, { name: "Owner Phone", source: "snapshot.homeownerPhone" },
      { name: "Estimated Cost Total", source: "computed.estimatedJobValue" }, { name: "Print Name", source: "project.homeownerName" },
    ],
    checkboxes: [], notes: "stub mapper",
  });
  const place = (source: string, x: number, y: number, label: string) => ({ source, page: 0, nx: x / 612, ny: 1 - y / 792, size: 9, maxWidthFrac: null, label });
  visionReply = JSON.stringify({
    fields: [
      place("snapshot.parcelNumber", 45, 703, "Map Number"),
      place("computed.estimatedJobValue", 195, 660, "Estimated Cost: Building"),
      place("computed.estimatedJobValue", 195, 645, "Estimated Cost: Electrical"),
      place("computed.applicantSignerName", 55, 539, "I, ___, as Owner"),
      place("computed.applicantSignerName", 155, 420, "Licence Holder"),
    ],
    signatures: [], notes: "stub vision",
  });
  const acq = await acquireFromBytes(db, provider, { ahj: "Town of Hybrid", state: "MA", formType: "permit_application", formName: "Hybrid Application", bytes: hybridBlank, sourceUrl: "" });
  const map = JSON.parse(db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE lower(ahj_name) = lower(?)", ["Town of Hybrid"])!.field_map);
  const overlays: Array<{ source: string; label?: string }> = map.overlayFields ?? [];
  const labels: string[] = (map.operatorItems ?? []).map((i: { label: string }) => i.label);
  await check("MUST-PASS: the widget-less Map Number placement is kept; the Total widget keeps the valuation", () => {
    assert.equal(acq.status, "acquired", acq.message);
    assert.ok(overlays.some((o) => o.label === "Map Number" && o.source === "snapshot.parcelNumber"), JSON.stringify(overlays));
    assert.equal(map.textFields["Estimated Cost Total"], "computed.estimatedJobValue");
    assert.equal(map.textFields["Owner Name"], "project.homeownerName");
  });
  await check("Total only: the two placed trade rows beside a Total widget do not carry the valuation", () => {
    assert.ok(!overlays.some((o) => /Estimated Cost: (Building|Electrical)/.test(String(o.label)) && o.source === "computed.estimatedJobValue"), JSON.stringify(overlays));
  });
  await check("one signer: a placed \"I, ___\" and the Print Name widget under one signature, bound to two people, are both dropped and named", () => {
    assert.ok(!overlays.some((o) => String(o.label).startsWith("I,")), JSON.stringify(overlays));
    assert.equal(map.textFields["Print Name"], undefined);
    assert.ok(labels.some((l) => /^I, ___.* \/ Print Name \(one signer/.test(l)), labels.join(" | "));
  });
  await check("licence holder: a placed licence-holder blank never carries the applicant signer", () => {
    assert.ok(!overlays.some((o) => o.label === "Licence Holder" && o.source === "computed.applicantSignerName"), JSON.stringify(overlays));
  });
  await check("the second pass adds no duplicate item (each stored operator item once)", () => {
    assert.equal(new Set(labels.map((l) => l.toLowerCase())).size, labels.length, labels.join(" | "));
  });
  // A FLAT blank (no widgets at all): the vision placements pass the same checks against the page text.
  const flatBlank = await blankOf(({ t, line }) => {
    t("ESTIMATED COSTS", 42, 700);
    t("Estimated Cost: Building", 42, 680); line(190, 677, 150);
    t("Estimated Cost: Electrical", 42, 665); line(190, 662, 150);
    t("Estimated Cost Total", 42, 650); line(190, 647, 150);
    t("Licence Holder", 42, 600); line(150, 597, 200);
    t("Owner Name", 42, 560); line(150, 557, 200);
  }, { widgets: false });
  visionReply = JSON.stringify({
    fields: [
      place("computed.estimatedJobValue", 195, 680, "Estimated Cost: Building"),
      place("computed.estimatedJobValue", 195, 665, "Estimated Cost: Electrical"),
      place("computed.estimatedJobValue", 195, 650, "Estimated Cost Total"),
      place("computed.applicantSignerName", 155, 600, "Licence Holder"),
      place("project.homeownerName", 155, 560, "Owner Name"),
    ],
    signatures: [], notes: "stub vision",
  });
  const flatAcq = await acquireFromBytes(db, provider, { ahj: "Town of Flat Checks", state: "MA", formType: "permit_application", formName: "Flat Checks", bytes: flatBlank, sourceUrl: "" });
  const flatMap = JSON.parse(db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE lower(ahj_name) = lower(?)", ["Town of Flat Checks"])!.field_map);
  const flatOverlays: Array<{ source: string; label?: string }> = flatMap.overlayFields ?? [];
  await check("FLAT form: only the Total placement keeps the valuation; the licence holder is not the applicant; the owner's name stays", () => {
    assert.equal(flatAcq.status, "acquired", flatAcq.message);
    assert.equal(flatMap.fillMode, "overlay");
    assert.deepEqual(flatOverlays.filter((o) => o.source === "computed.estimatedJobValue").map((o) => o.label), ["Estimated Cost Total"]);
    assert.ok(!flatOverlays.some((o) => o.label === "Licence Holder" && o.source === "computed.applicantSignerName"), JSON.stringify(flatOverlays));
    assert.ok(flatOverlays.some((o) => o.label === "Owner Name" && o.source === "project.homeownerName"));
  });
  // forms-fill-3 (skeptic E1): a SCANNED form — no text layer at all, lines only. The owner's "I, ___
  // authorize" block and, below the owner's signature line the vision pass FOUND, the contractor's
  // Print Name: two people, correctly bound. The vision signature lines stand in as signature widgets.
  const sig = (role: string, x: number, y: number, label: string) => ({ role, page: 0, nx: x / 612, ny: 1 - y / 792, widthFrac: 0.35, heightFrac: 0.03, dateNx: null, dateNy: null, label });
  const twoBlocks = {
    fields: [
      place("project.homeownerName", 55, 703, "I, ___, as owner of the property, authorize the contractor"),
      place("computed.applicantSignerName", 55, 623, "Contractor Print Name"),
    ],
    signatures: [sig("owner", 55, 663, "Owner Signature"), sig("contractor", 55, 593, "Contractor Signature")],
    notes: "stub vision",
  };
  const scanned = await blankOf(({ line }) => { line(50, 700, 250); line(50, 660, 250); line(50, 620, 250); line(50, 590, 250); }, { widgets: false });
  visionReply = JSON.stringify(twoBlocks);
  const scannedAcq = await acquireFromBytes(db, provider, { ahj: "Town of Scanned", state: "MA", formType: "permit_application", formName: "Scanned Application", bytes: scanned, sourceUrl: "" });
  const scannedMap = JSON.parse(db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE lower(ahj_name) = lower(?)", ["Town of Scanned"])!.field_map);
  await check("MUST-PASS (skeptic E1): on a SCANNED form the found signature line separates the owner's block from the contractor's — both names kept, no one-signer item", () => {
    assert.equal(scannedAcq.status, "acquired", scannedAcq.message);
    const placed = (scannedMap.overlayFields ?? []).map((o: { label?: string; source: string }) => `${o.label} <- ${o.source}`);
    assert.deepEqual(placed, [
      "I, ___, as owner of the property, authorize the contractor <- project.homeownerName",
      "Contractor Print Name <- computed.applicantSignerName",
    ]);
    assert.ok(!(scannedMap.operatorItems ?? []).some((i: { label: string }) => /one signer/.test(i.label)), JSON.stringify(scannedMap.operatorItems));
  });
  // The same scanned page with NO signature line found between the two: one block, two people — flagged.
  visionReply = JSON.stringify({ ...twoBlocks, signatures: [sig("contractor", 55, 593, "Contractor Signature")] });
  await acquireFromBytes(db, provider, { ahj: "Town of Scanned One", state: "MA", formType: "permit_application", formName: "Scanned Application", bytes: scanned, sourceUrl: "" });
  const oneMap = JSON.parse(db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE lower(ahj_name) = lower(?)", ["Town of Scanned One"])!.field_map);
  await check("MUST-EXCLUDE: the scanned pair with no signature line between them is still one signer — both dropped and named", () => {
    assert.ok(!(oneMap.overlayFields ?? []).some((o: { label?: string }) => /^I,|Contractor Print Name/.test(String(o.label))), JSON.stringify(oneMap.overlayFields));
    assert.ok((oneMap.operatorItems ?? []).some((i: { label: string }) => /one signer/.test(i.label)), JSON.stringify(oneMap.operatorItems));
  });
  // The AcroForm branch: the same two blocks as vision placements beside a widget-bearing form.
  const acroScanned = await blankOf(({ box, line }) => { box("Permit Number", 40, 760, 200); line(50, 700, 250); line(50, 660, 250); line(50, 620, 250); line(50, 590, 250); });
  acroReply = JSON.stringify({ textFields: [{ name: "Permit Number", source: "operator:Permit Number" }], checkboxes: [], notes: "stub mapper" });
  visionReply = JSON.stringify(twoBlocks);
  await acquireFromBytes(db, provider, { ahj: "Town of Scanned Acro", state: "MA", formType: "permit_application", formName: "Scanned Acro Application", bytes: acroScanned, sourceUrl: "" });
  const acroMap = JSON.parse(db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE lower(ahj_name) = lower(?)", ["Town of Scanned Acro"])!.field_map);
  await check("MUST-PASS (AcroForm branch): the vision signature line separates the two placed blocks there too — both names kept", () => {
    const placed = (acroMap.overlayFields ?? []).map((o: { label?: string; source: string }) => `${o.label} <- ${o.source}`);
    assert.ok(placed.includes("I, ___, as owner of the property, authorize the contractor <- project.homeownerName"), JSON.stringify(acroMap));
    assert.ok(placed.includes("Contractor Print Name <- computed.applicantSignerName"), JSON.stringify(acroMap));
  });
}

server.close();
db.close();
console.log(failures ? `\nformsFillRight: ${failures} FAILED, ${passed} passed` : `\nformsFillRight: all ${passed} checks passed — captions reach the mapper (no project value does), the shape guard, licence by state, one signer one name, the Total row only, vision placements where no widget is, named operator items, and a verified map is never re-mapped`);
process.exit(failures ? 1 : 0);
