// THE PACKET'S OWN PERMIT APPLICATION STATES THE CONTRACT VALUE AND THE OWNER PHONE (#201).
//
// A real Utah packet (kept local) carried the city's signed permit application with a text
// layer: a stated job value and the homeowner's phone. The parse used neither — the reviewer
// said "No contract value on file, using a per-watt estimate" (reviewer.submit.valuation-estimate)
// and "Homeowner phone missing" — and racking came back as a title-block string while PV-2 said
// "UNIRAC SOLARMOUNT RACKING" and PV-3 "UNIRAC FLASHLOC".
//
//   MUST-PASS    a filled application page -> jobValue = the stated CONTRACT price (page cited),
//                no valuation-estimate finding; a stated Job Value / Valuation is the DECLARED
//                valuation (statedValuation), never jobValue (valuation.ts, ruling 2026-09-21);
//                owner phone filled (never the contractor's); racking "Unirac SolarMount" from
//                the callout, attachment "Unirac FlashLoc"; a differing model reading is kept as
//                a structured conflict.
//   MUST-EXCLUDE a BLANK application template ("Job Value ________") fills nothing; a cover
//                sheet's general notes mentioning the permit application fill nothing; two
//                disagreeing stated values fill nothing; a fee / minimum note is no value; a
//                contractor block's "Owner:" line, a toll-free number, or a net-metering
//                agreement never supply the homeowner phone; a title-block racking string is dropped.
//
// Synthetic text only — no real homeowner, address or phone. 555-01xx numbers are fictional.
//
//   npx tsx backend/test/packetApplicationFields.test.ts
import "./_isolate";
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const { supplementPacketApplication, readPacketApplication } = await import("../src/packetApplication");
const { buildReviewerReport } = await import("../src/reviewerEngine");
const { resolveValuation } = await import("../src/valuation");

let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (err) { failed++; console.log(`FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`); }
};

const stub = (fields: Record<string, unknown> = {}) => ({ provider: "stub", fields, lowConfidenceFields: [], notes: "" }) as never;
const TITLE_BLOCK = "RACKING HARDWARE PAT EXAMPLE RESIDENCE NEW PHOTOVOLTAIC SYSTEM PROJECT - 9.020 KW DC / 7.600 KW AC";

const PACKET = [
  "--- PAGE 1 ---",
  "PV-1 COVER SHEET SYSTEM SIZE 9.020 KW DC 7.600 KW AC OCCUPANCY R-3 DESIGN SPECIFICATION 30 PSF RESIDENTIAL SINGLE FAMILY",
  TITLE_BLOCK,
  "--- PAGE 2 ---",
  "PV-2 SITE PLAN (N) PV MODULES ON UNIRAC SOLARMOUNT RACKING ROOF #1 22 MODULES",
  "--- PAGE 3 ---",
  "PV-3 ATTACHMENT DETAIL UNIRAC FLASHLOC ATTACHMENT @ 48\" O.C. MAX",
  "--- PAGE 4 ---",
  "CITY OF EXAMPLEVILLE BUILDING PERMIT APPLICATION",
  "PROPERTY OWNER Name: Pat Example Address: 100 Sample Way Owner phone: 555-555-0142",
  "CONTRACTOR Name: Example Solar LLC Phone: (555) 555-0199",
  "DESCRIPTION OF WORK: ROOF MOUNTED PV SYSTEM Contract price: $31,450.00 Job value: $12,580 Signed: Pat Example (e-signed)",
].join("\n");

check("MUST-PASS: the application page's CONTRACT price fills jobValue with its source page cited", () => {
  const out = supplementPacketApplication(stub(), PACKET);
  assert.equal(out.fields.jobValue?.value, 31450);
  assert.match(String(out.fields.jobValue?.evidence?.sheet), /^Page 4\b/);
  assert.match(String(out.fields.jobValue?.evidence?.excerpt), /Contract price: \$31,450\.00/);
  // The Job Value box on the same page is the DECLARED valuation: recorded, never jobValue.
  assert.equal(out.fields.statedValuation?.value, 12580);
  assert.match(String(out.fields.statedValuation?.evidence?.sheet), /^Page 4\b/);
});

check("MUST-PASS: the owner phone on that page fills homeownerPhone (never the contractor's)", () => {
  const out = supplementPacketApplication(stub(), PACKET);
  assert.equal(out.fields.homeownerPhone?.value, "(555) 555-0142");
  assert.match(String(out.fields.homeownerPhone?.evidence?.sheet), /^Page 4\b/);
});

check("MUST-PASS: an owner block's bare 'Phone' is the owner's; the contractor block's is not", () => {
  const read = readPacketApplication("--- PAGE 7 ---\nBUILDING PERMIT APPLICATION OWNER INFORMATION Name: Pat Example Phone: 555.555.0177 CONTRACTOR Phone: 555-555-0199 Project value $28,000");
  assert.equal(read.homeownerPhone?.value, "(555) 555-0177");
  const contractorOnly = readPacketApplication("--- PAGE 7 ---\nBUILDING PERMIT APPLICATION CONTRACTOR Name: Example Solar LLC Phone: 555-555-0199");
  assert.equal(contractorOnly.homeownerPhone, undefined);
});

check("MUST-PASS: racking comes from the callout, never the title block; attachment from its callout", () => {
  const out = supplementPacketApplication(stub({ rackingSystem: { value: "Hardware Pat Example Residence New Photovoltaic System Project - 9.020 Kw Dc / 7.600 Kw Ac", confidence: 0.6 } }), PACKET);
  assert.equal(out.fields.rackingSystem?.value, "Unirac SolarMount");
  assert.match(String(out.fields.rackingSystem?.evidence?.sheet), /^Page 2\b/);
  assert.equal(out.fields.attachmentHardware?.value, "Unirac FlashLoc");
});

check("MUST-PASS: the stated value reaches the reviewer — no valuation-estimate, no phone callout", () => {
  const out = supplementPacketApplication(stub(), PACKET);
  const snap = Object.fromEntries(Object.entries(out.fields).map(([k, v]) => [k, (v as { value: unknown }).value]));
  assert.equal(resolveValuation(snap as never, 9.02).method, "contract");
  const project = { id: "p-201", homeownerName: "Pat Example", projectAddress: "100 Sample Way", state: "UT", ahj: "City of Exampleville",
    utility: "Example Power", systemSizeDcKw: 9.02, systemSizeAcKw: 7.6, parserSnapshot: { ...snap, systemSizeDcKw: 9.02 } } as never;
  const ids = buildReviewerReport(project).findings.map((f) => f.id);
  assert.ok(!ids.includes("reviewer.submit.valuation-estimate"), `valuation-estimate still raised: ${ids.join(", ")}`);
  assert.ok(!ids.includes("reviewer.submit.homeowner-phone"), "homeowner-phone still raised");
  // Control: the same project WITHOUT the application page does estimate.
  const bare = { ...(project as object), parserSnapshot: { systemSizeDcKw: 9.02 } } as never;
  assert.ok(buildReviewerReport(bare).findings.some((f) => f.id === "reviewer.submit.valuation-estimate"), "control: estimate expected");
});

check("MUST-EXCLUDE: a BLANK application template fills nothing", () => {
  const blank = [
    "--- PAGE 9 ---",
    "BUILDING PERMIT APPLICATION PROPERTY OWNER Name ____________ Owner phone ____________",
    "CONTRACTOR Phone ____________ Job Value ________ Contract Price $ ________ Permit fee schedule 1,000 2,000",
  ].join("\n");
  const out = supplementPacketApplication(stub(), blank);
  assert.equal(out.fields.jobValue, undefined);
  assert.equal(out.fields.homeownerPhone, undefined);
  assert.equal(out.fields.rackingSystem, undefined);
});

check("MUST-EXCLUDE: a job value on a page that is not an application or contract fills nothing", () => {
  const out = supplementPacketApplication(stub(), "--- PAGE 1 ---\nPV-1 COVER SHEET PROJECT VALUE $31,450 OWNER PHONE 555-555-0142");
  assert.equal(out.fields.jobValue, undefined);
  assert.equal(out.fields.homeownerPhone, undefined);
});

check("MUST-EXCLUDE: two application pages stating different values fill nothing", () => {
  const two = "--- PAGE 4 ---\nBUILDING PERMIT APPLICATION OWNER Name: A CONTRACTOR Name: B Contract price $31,450 Job value $12,580\n"
    + "--- PAGE 5 ---\nELECTRICAL PERMIT APPLICATION OWNER Name: A CONTRACTOR Name: B Contract price $12,000 Job value $4,800";
  const out = supplementPacketApplication(stub(), two);
  assert.equal(out.fields.jobValue, undefined);
  assert.equal(out.fields.statedValuation, undefined);
});

check("MUST-EXCLUDE: a title-block racking string with no callout is dropped, not kept", () => {
  const out = supplementPacketApplication(stub({ rackingSystem: { value: "Hardware Pat Example Residence New Photovoltaic System Project - 9.020 Kw Dc", confidence: 0.6 } }), `--- PAGE 1 ---\n${TITLE_BLOCK}`);
  assert.equal(out.fields.rackingSystem, undefined);
  // A real product the model read (not in the callout table) is left alone.
  const kept = supplementPacketApplication(stub({ rackingSystem: { value: "Acme RailCo 200", confidence: 0.8 } }), "--- PAGE 1 ---\nPV-2 ACME RAILCO 200 RAILS");
  assert.equal(kept.fields.rackingSystem?.value, "Acme RailCo 200");
});

check("MUST-PASS: each side of the contract / valuation split, alone", () => {
  const form = (line: string) => `--- PAGE 3 ---\nBUILDING PERMIT APPLICATION PROPERTY OWNER Name: Pat Example CONTRACTOR Name: Example Solar LLC ${line}`;
  const valuationOnly = readPacketApplication(form("Job value: $12,580"));
  assert.equal(valuationOnly.jobValue, undefined, "a Job Value box is never the contract");
  assert.equal(valuationOnly.statedValuation?.value, 12580);
  // Through the supplement too: a Job Value alone leaves jobValue empty, so the filed valuation
  // is never 40% of the application's own declared valuation.
  const supplemented = supplementPacketApplication(stub(), form("Job value: $12,580"));
  assert.equal(supplemented.fields.jobValue, undefined);
  assert.equal(supplemented.fields.statedValuation?.value, 12580);
  for (const label of ["Valuation of work $12,580", "Construction value: 12,580.00", "Project cost $12,580"]) {
    const r = readPacketApplication(form(label));
    assert.equal(r.jobValue, undefined, label);
    assert.equal(r.statedValuation?.value, 12580, label);
  }
  const contractOnly = readPacketApplication(form("Contract amount: $31,450"));
  assert.equal(contractOnly.jobValue?.value, 31450);
  assert.equal(contractOnly.statedValuation, undefined);
  // A solar sales contract bound into the packet states the contract price too.
  const agreement = readPacketApplication("--- PAGE 9 ---\nSOLAR ENERGY SYSTEM PURCHASE AGREEMENT Buyer: Pat Example Total contract price $31,450.00");
  assert.equal(agreement.jobValue?.value, 31450);
});

check("MUST-PASS: a differing model reading is kept as a structured conflict, the page value fills", () => {
  const out = supplementPacketApplication(stub({ jobValue: { value: 30000, confidence: 0.7, evidence: { source: "plan_set", sheet: "PV-1", excerpt: "30,000" } } }), PACKET);
  assert.equal(out.fields.jobValue?.value, 31450);
  const c = (out.conflicts ?? []).find((x: { field: string }) => x.field === "jobValue");
  assert.ok(c, "conflict recorded");
  assert.deepEqual(c!.readings.map((r: { value: unknown }) => String(r.value)), ["31450", "30000"]);
  // The same value read twice is no conflict.
  const agree = supplementPacketApplication(stub({ jobValue: { value: "$31,450", confidence: 0.7 } }), PACKET);
  assert.equal((agree.conflicts ?? []).length, 0);
});

check("MUST-EXCLUDE: a cover sheet's general notes naming the permit application fill nothing", () => {
  const notes = "GENERAL NOTES 1. CONTRACTOR SHALL SUBMIT THE BUILDING PERMIT APPLICATION TO THE AHJ.\n"
    + "2. OWNER: PAT EXAMPLE OWNER PHONE: 555-555-0142 PROJECT COST $31,450 (FOR FEE ESTIMATE ONLY) CONTRACT PRICE $31,450";
  for (const text of [`--- PAGE 1 ---\nPV-1 COVER SHEET\n${notes}`, notes]) {
    const out = supplementPacketApplication(stub(), text);
    assert.equal(out.fields.jobValue, undefined);
    assert.equal(out.fields.statedValuation, undefined);
    assert.equal(out.fields.homeownerPhone, undefined);
  }
});

check("MUST-EXCLUDE: a fee / minimum note after a value label is no stated value", () => {
  const r = readPacketApplication("--- PAGE 3 ---\nBUILDING PERMIT APPLICATION OWNER Name: A CONTRACTOR Name: B Job value $1,000 minimum Contract price $1,500 fee");
  assert.equal(r.jobValue, undefined);
  assert.equal(r.statedValuation, undefined);
});

check("MUST-EXCLUDE: the homeowner phone never comes from another party or document", () => {
  // A contractor block's "Owner:" line is a field inside the CONTRACTOR's block.
  const contractorOwner = readPacketApplication("--- PAGE 3 ---\nBUILDING PERMIT APPLICATION PROPERTY OWNER Name: Pat Example CONTRACTOR Name: Example Solar LLC Owner: Sam Sample Phone: 555-555-0123");
  assert.equal(contractorOwner.homeownerPhone, undefined);
  // A toll-free number is a company's.
  const tollFree = readPacketApplication("--- PAGE 3 ---\nBUILDING PERMIT APPLICATION PROPERTY OWNER Name: Pat Example Phone: (888) 555-0100 CONTRACTOR Name: B");
  assert.equal(tollFree.homeownerPhone, undefined);
  // A net-metering / interconnection agreement bound into the packet is no permit application.
  const nem = readPacketApplication("--- PAGE 11 ---\nNET METERING INTERCONNECTION AGREEMENT CUSTOMER OWNER Name: Pat Example Phone: 555-555-0142 Utility contractor desk");
  assert.equal(nem.homeownerPhone, undefined);
  // An "Owner/Agent" phone is the agent's as much as the owner's: refused.
  const agent = readPacketApplication("--- PAGE 3 ---\nBUILDING PERMIT APPLICATION PROPERTY OWNER Name: Pat Example CONTRACTOR Name: B Owner/Agent Phone: 555-555-0166");
  assert.equal(agent.homeownerPhone, undefined);
});

check("WIRING: /api/parser/llm-extract runs the packet-application read on the text response", () => {
  const server = fs.readFileSync(path.join(REPO, "backend", "src", "server.ts"), "utf8");
  const route = server.slice(server.indexOf('app.post("/api/parser/llm-extract"'));
  const body = route.slice(0, route.indexOf("\n}));"));
  assert.match(body, /supplementPacketApplication\(extraction, planText\)/);
});

// parser.html: the regex fallback refuses a title-block capture, and the callout value fills the
// visible Racking box (so the saved `racking` key is the product, not the title block).
const html = fs.readFileSync(process.env.PARSER_HTML_PATH || path.join(REPO, "frontend", "parser.html"), "utf8");
function liftFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `parser.html defines ${name}`);
  let i = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

check("PARSER PAGE: the RACKING regex fallback refuses a title-block capture", () => {
  const consts = ["clean", "title"].map((n) => html.match(new RegExp(`const ${n} = v => [^\\n]+`))?.[0]);
  assert.ok(consts.every(Boolean), "parser.html defines clean/title");
  const code = [...consts, ...["normalizeText", "matchFirst", "parseRackingLine"].map((n) => liftFunction(html, n))].join("\n");
  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(`${code}\nthis.parseRackingLine = parseRackingLine;`, sandbox);
  const parse = sandbox.parseRackingLine as (cover: string) => string;
  assert.equal(parse(TITLE_BLOCK), "");
  assert.equal(parse("RACKING: IRONRIDGE XR100\nUTILITY: EXAMPLE POWER"), "Ironridge Xr100");
});

check("PARSER PAGE: the text read's rackingSystem fills the Racking box", () => {
  const literal = html.match(/const LLM_FIELD_TARGETS = (\{[\s\S]*?\n\});/)?.[1];
  assert.ok(literal, "parser.html defines LLM_FIELD_TARGETS");
  const targets = vm.runInNewContext(`(${literal})`) as Record<string, string[]>;
  assert.equal(JSON.stringify(targets.rackingSystem), JSON.stringify(["racking"]));
});

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\npacketApplicationFields: all checks passed");
