// BCD 5952 COMPLETE (B5) + "a fact no document states becomes an operator QUESTION".
//
// City of Jefferson's 5952 went out with the roofing and module-height rows blank, the listing
// agency, structure description and BCD license # blank, and a fill note blaming "roof material
// and layer count" on a job whose roof material WAS parsed. The operator read the blank row beside
// the form's own metal/standing-seam wording as "it's filling in metal roofing".
//
// The rule now: a fact another record holds is filled from it (BCD license # — the client's
// electrical contractor licence, ONLY from the client record; the listing agency — the module
// datasheet, text first, then a vision read); a fact no document states is ASKED through the
// existing portal-question/intake mechanism, stored on the project, and read by the form.
//
// KILL TESTS (verified red by hand before the fix landed):
//   K1 intakeRequests: drop formFactIntakeQuestions                    → (q1) fails.
//   K2 bcdChecklistFacts.bcd5952SnapshotAdditions: drop the client map → (f2) fails.
//   K3 bcdChecklistAnswers: ignore moduleHeightFiguresCompliant         → (q2) fails.
//   K4 moduleListing: accept a vision answer its quote does not support → (v2) fails.
//
// Run: npx tsx backend/test/bcd5952Complete.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bcd5952-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const repo = await import("../src/repository");
const clients = await import("../src/clients");
const docs = await import("../src/projectDocuments");
const intake = await import("../src/intakeRequests");
const facts = await import("../src/bcdChecklistFacts");
const forms = await import("../src/ahjForms");
const listing = await import("../src/moduleListing");
const pp = await import("../src/permitProcess");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

const client = clients.createClient(db, { companyName: "Fivenine Solar LLC", ccbLicenseNumber: "111111", electricalLicenseNumber: "C9999" });
const JOB = {
  owner: "Form Facts Owner", street: "5 Test Ln", city: "Maple Hollow", state: "OR", zip: "97352", ahj: "City of Maple Hollow",
  utility: "Pacific Power", dcKw: "5", acKw: "4", moduleMake: "Qcells", moduleModel: "Q.TRON BLK M-G2.C1+/AC",
  roofMaterial: "Composition Shingle", framingType: "truss", roofRafterSpacing: "24", attachmentToFraming: "yes", attachmentSpacingIn: "24",
  gravityWindDesign: "yes", manufacturerInstallation: "yes", snow: "20", wind: "C", windSpeed: "110", permitPath: "PRESCRIPTIVE",
};
const make = (over: Record<string, string> = {}) => repo.createProject(db, { clientId: client.id, ...JOB, ...over } as never).project;
const reload = (id: string) => repo.getProjectDetail(db, id).project;

await check("(q1) MUST-PASS: an Oregon comp-shingle job with no layer count, height or structure statement is ASKED, not guessed", async () => {
  const p = make();
  const qs = await intake.unansweredPortalQuestions(db, p);
  const keys = qs.map((q) => q.key);
  for (const k of ["roofLayers", "moduleHeightFiguresCompliant", "structureDescription"]) assert.ok(keys.includes(k), `${k} not asked: ${keys.join(",")}`);
  assert.equal(facts.bcdChecklistAnswers(p).roofing, "", "unknown layers stay blank until answered, never a guess");
});

await check("(q2) MUST-PASS: the operator's answers land on the project and every row they settle fills", async () => {
  const p = make();
  await intake.answerPortalQuestions(db, p.id, { roofLayers: "1", moduleHeightFiguresCompliant: "Yes", structureDescription: "Single-family dwelling" });
  const after = reload(p.id);
  const a = facts.bcdChecklistAnswers(after);
  assert.equal(a.roofing, "Yes");
  assert.equal(a.heightFigures, "Yes");
  const ctx = forms.buildContext(db, after);
  assert.equal(forms.resolveSource("snapshot.structureDescription", ctx), "Single-family dwelling");
  assert.deepEqual((await intake.unansweredPortalQuestions(db, after)).map((q) => q.key).filter((k) => ["roofLayers", "moduleHeightFiguresCompliant", "structureDescription"].includes(k)), []);
});

await check("(q3) MUST-EXCLUDE: a 3-layer comp roof answers No; a metal roof answers Yes with no layer question, and Method 2 comes from the standing-seam fact", async () => {
  assert.equal(facts.bcdChecklistAnswers(make({ roofLayers: "3 or more" })).roofing, "No");
  const metal = make({ roofMaterial: "Standing seam metal", standingSeamMethod2Compliant: "yes", attachmentToFraming: "", attachmentSpacingIn: "" });
  const a = facts.bcdChecklistAnswers(metal);
  assert.equal(a.roofing, "Yes");
  assert.equal(a.method2, "Yes");
  assert.equal(a.attachments, "Yes");
  assert.ok(!(await intake.unansweredPortalQuestions(db, metal)).some((q) => q.key === "roofLayers"));
});

await check("(q4) the fill note names the ONE missing fact — never 'roof material' when the material was parsed", () => {
  const missing = facts.bcd5952MissingFacts(make()).map((m) => m.missing).join(" | ");
  assert.match(missing, /roof layer count/);
  assert.doesNotMatch(missing, /^roof material/);
});

await check("(z1) a county issuing for a city asks about the city's zoning sign-off; a city issuing its own does not", async () => {
  const save = (ahj: string, agency: string) => pp.savePermitProcessLookup(db, {
    state: "OR", ahj, lookedUpAt: new Date().toISOString(),
    issuingAgency: { value: agency, sourceUrl: "https://example.gov", quote: `${agency} issues permits`, origin: "lookup" },
    permitStructure: { value: "separate", sourceUrl: "https://example.gov", quote: "q", origin: "lookup" }, permits: [],
  });
  save("City of Maple Hollow", "Marion County");
  assert.ok((await intake.unansweredPortalQuestions(db, make())).some((q) => q.key === "zoningApproval"));
  save("City of Oak Ridge", "City of Oak Ridge");
  assert.ok(!(await intake.unansweredPortalQuestions(db, make({ ahj: "City of Oak Ridge", city: "Oak Ridge" }))).some((q) => q.key === "zoningApproval"));
});

await check("(f1) MUST-PASS: BCD license # comes from the client's electrical contractor licence", () => {
  const ctx = forms.buildContext(db, make());
  assert.equal(forms.resolveSource("snapshot.bcdLicenseNumber", ctx), "C9999");
});
await check("(f2) MUST-EXCLUDE: never from anything but the client record, and never outside Oregon", () => {
  const bare = clients.createClient(db, { companyName: "No Licence LLC" });
  const p = repo.createProject(db, { clientId: bare.id, ...JOB, electricianLicenseNumber: "5555S" } as never).project;
  assert.equal(forms.resolveSource("snapshot.bcdLicenseNumber", forms.buildContext(db, p)), "");
  const wa = make({ state: "WA", ahj: "City of Maple Hollow WA", zip: "98000" });
  assert.equal(facts.bcd5952SnapshotAdditions(wa, { electricalLicenseNumber: "C9999" }).bcdLicenseNumber, undefined);
});

// ── Listing agency: text, then vision ────────────────────────────────────────────────────
const { PDFDocument } = await import("pdf-lib");
const blankPdf = Buffer.from(await (await PDFDocument.create().then(async (d) => { d.addPage([300, 300]); return d; })).save());
const withSpec = () => {
  const p = make();
  docs.saveProjectDocument(db, p.id, { docType: "module_spec", filename: "module.pdf", contentType: "application/pdf", buffer: blankPdf, source: "upload" });
  return reload(p.id);
};
await check("(v1) MUST-PASS: a vision read whose quote names the mark fills the listing agency, with its evidence", async () => {
  const p = withSpec();
  const stub = { visionExtract: async () => ({ listingAgency: "UL", standards: ["UL 61730-1"], quote: "UL 61730-1 & UL 61730-2" }) };
  const r = await listing.ensureModuleListingAgency(db, p, stub as never);
  assert.equal(r.agency, "UL");
  assert.equal(r.source, "vision");
  assert.equal(reload(p.id).parserSnapshot.moduleListingAgency, "UL");
  assert.match(String(reload(p.id).parserSnapshot.moduleListingAgencyEvidence), /vision read.*61730/);
});
await check("(v2) MUST-EXCLUDE: an answer its own printed words do not support is not taken, and the read is not paid for twice", async () => {
  const p = withSpec();
  let calls = 0;
  const stub = { visionExtract: async () => { calls++; return { listingAgency: "UL", quote: "Module efficiency 21.6%" }; } };
  assert.equal((await listing.ensureModuleListingAgency(db, p, stub as never)).agency, "");
  assert.equal(reload(p.id).parserSnapshot.moduleListingAgency ?? "", "");
  const before = calls;
  await listing.ensureModuleListingAgency(db, reload(p.id), stub as never);
  assert.equal(calls, before, "a datasheet already read is not read again");
});
await check("(v3) listingAgencyFromText reads the marks and ignores a page with none", () => {
  assert.equal(facts.listingAgencyFromText("Certified to UL 61730-1").agency, "UL");
  assert.equal(facts.listingAgencyFromText("ETL listed to UL 1741").agency, "ETL (Intertek)", "the mark is the agency; UL 1741 is only the standard");
  assert.equal(facts.listingAgencyFromText("Intertek ETL").agency, "ETL (Intertek)");
  assert.equal(facts.listingAgencyFromText("Rev 00 PV MODULE / INV SPECIFICATION SHEET").agency, "");
});

if (failures) { console.error(`\n${failures} bcd5952Complete test(s) failed.`); process.exit(1); }
console.log("\nAll bcd5952Complete tests passed.");
process.exit(0);
